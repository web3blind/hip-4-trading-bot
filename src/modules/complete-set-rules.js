import { MAX_COMPLETE_SET_LEGS } from './constants.js';
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = text => {
  if (!/^\d{8}-\d{4}$/.test(text || '')) return NaN;
  const ms=Date.parse(`${text.slice(0,4)}-${text.slice(4,6)}-${text.slice(6,8)}T${text.slice(9,11)}:${text.slice(11)}:00Z`);
  return Number.isFinite(ms) ? ms : NaN;
};
function fields(text) {
  if (typeof text !== 'string' || text.length > 2000) return null;
  const pairs=new Map();
  for (const part of text.split('|')) {
    const i=part.indexOf(':');if (i<1) return null;
    const key=part.slice(0,i), value=part.slice(i+1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || !value || /[{}|]/.test(value) || pairs.has(key)) return null;
    pairs.set(key,value);
  }
  return pairs;
}
function validTemplateValues(template, values) {
  return Array.isArray(template?.keywords) && values && template.keywords.length===values.size &&
    template.keywords.every(([key])=>values.has(key));
}
function sportsThreeWay(q, named, fallback, templateById) {
  const parent=q.name?.startsWith('template:') ? templateById.get(q.name.slice(9)) : null;
  const p=fields(q.description), desc=parent?.description;
  if (parent?.role!=='question' || !validTemplateValues(parent,p) ||
      !desc?.includes('Exactly one corresponding named outcome resolves to Yes; the other two and the fallback resolve to No.') ||
      !desc.includes('Draw also resolves to Yes if the Contest Result records a no contest or no winner, names an unlisted winner, or is not established by') ||
      named.length!==3 || !p?.get('participantA') || !p?.get('participantB') || p.get('participantA')===p.get('participantB') ||
      !Number.isFinite(stamp(p.get('scheduledStart'))) || !Number.isFinite(stamp(p.get('resolutionDeadline')))) return false;
  const child=(o,type,participant)=>{
    if (o?.name!==`template:${type}` || o?.description!==(participant ? `participant:${participant}` : '')) return false;
    const t=templateById.get(type);
    if (t?.role?.questionOutcome?.parent!==parent.id || !validTemplateValues(t,fields(o.description) ?? (o.description===''?new Map():null))) return false;
    return participant ? t.description?.includes('sole winner of the Contest under the parent question') && t.description?.includes('otherwise resolves to No') :
      t.description?.includes('Residual Conditions apply') && t.description?.includes('otherwise resolves to No');
  };
  return fallback?.name==='template fallback' && fallback.description==='other' &&
    child(named[0],'sportsContestParticipant2',p.get('participantA')) &&
    child(named[1],'sportsContestDraw2',null) &&
    child(named[2],'sportsContestParticipant2',p.get('participantB'));
}

// Reviewed full official rule texts (outcomeTemplates), not just an indicative phrase.
// See tests/fixtures/coverage-markets.json for readable source text. Any text change
// restores mandatory fallback coverage until the new rules have been reviewed.
const POLICY_RULE_HASHES = {
  policyRateDecision:'a04bb003049ed373e469ca193683a477d8c7d18a328a828c56ebf9d7b0ab6e8b',
  policyRateDecrease:'5fe9c17e5464ef865acc209eef236121860fd13632bca7ead77d926a9502fc89',
  policyRateIncrease:'d9170b7ade7075d468b6bd9a71bb1b17ccd8223660f94a62b1393ec370b74342',
  policyRateNoChange:'963155bd3b7acb0f84cc00772ac7b7d20a8d609335f8dbc57150d227d9db89d2',
};
const reviewedPolicyRule = (t,id) => typeof t?.description==='string' &&
  createHash('sha256').update(t.description).digest('hex')===POLICY_RULE_HASHES[id];
function policyThreeWay(q,named,fallback,templateById) {
  if (q.name!=='template:policyRateDecision' || named.length!==3 ||
      fallback?.name!=='template fallback' || fallback.description!=='other') return false;
  const parent=templateById.get('policyRateDecision'), p=fields(q.description);
  if (parent?.role!=='question' || !reviewedPolicyRule(parent,'policyRateDecision') ||
      !validTemplateValues(parent,p) || !Number.isFinite(stamp(p.get('scheduledDecision'))) ||
      !Number.isFinite(stamp(p.get('decisionDeadline'))) || stamp(p.get('decisionDeadline'))<stamp(p.get('scheduledDecision'))) return false;
  const expected=['policyRateNoChange','policyRateDecrease','policyRateIncrease'];
  return expected.every(id=>{
    const children=named.filter(o=>o.name===`template:${id}`), t=templateById.get(id);
    return children.length===1 && children[0].description==='' &&
      t?.role?.questionOutcome?.parent==='policyRateDecision' &&
      validTemplateValues(t,new Map()) && reviewedPolicyRule(t,id);
  });
}

function reviewedTournament(q,named,fallback,templateById) {
  if (q.name!=='template:sportsTournamentWinner' || fallback?.name!=='template fallback' || fallback.description!=='other') return false;
  const parent=templateById.get('sportsTournamentWinner'), child=templateById.get('sportsTournamentParticipant');
  const matches=(t,hash)=>typeof t?.description==='string' && createHash('sha256').update(t.description).digest('hex')===hash;
  // Full official rule texts are preserved in the public metadata fixture.
  if (parent?.role!=='question' || !validTemplateValues(parent,fields(q.description)) ||
      !matches(parent,'51c146930cc81d38b2e9af3320ff759c3dacf7a09219820578a41315e9e66871') ||
      child?.role?.questionOutcome?.parent!=='sportsTournamentWinner' ||
      !matches(child,'68ed69e25a43c5b51903d8b3ae32056f9b6675fa13d26d9d8dc788208e4f595d')) return false;
  const participants=new Set();
  return named.every(o=>{
    const p=fields(o.description), participant=p?.get('participant');
    if (o.name!=='template:sportsTournamentParticipant' || !participant ||
        !validTemplateValues(child,p) || participants.has(participant)) return false;
    participants.add(participant);return true;
  });
}

/** Derive candidates from current official metadata and template texts, never market IDs. */
export function completeSetQuestions(meta, templates, now=Date.now()) {
  if (!Array.isArray(meta?.questions) || !Array.isArray(meta?.outcomes) || !Array.isArray(templates)) return [];
  const byId=new Map(meta.outcomes.map(o=>[o?.outcome,o]));
  const templateById=new Map(templates.map(t=>[t?.id,t]));
  return meta.questions.flatMap(q=>{
    const ids=q?.namedOutcomes;
    if (!Number.isSafeInteger(q?.question) || !Array.isArray(ids) || ids.length<2 || ids.length>MAX_COMPLETE_SET_LEGS ||
      !ids.every(Number.isSafeInteger) || new Set(ids).size!==ids.length || ids.includes(q.fallbackOutcome) ||
      !Number.isSafeInteger(q.fallbackOutcome) || !Array.isArray(q.settledNamedOutcomes) || q.settledNamedOutcomes.length ||
      q.settledFallbackOutcome != null) return [];
    const named=ids.map(id=>byId.get(id)), fallback=byId.get(q.fallbackOutcome);
    if (named.some(o=>o?.quoteToken!=='USDC' || !Array.isArray(o.sideSpecs) || o.sideSpecs[0]?.name!=='Yes' || o.sideSpecs[1]?.name!=='No') ||
      fallback?.quoteToken!=='USDC' || !Array.isArray(fallback.sideSpecs) || fallback.sideSpecs[0]?.name!=='Yes' || fallback.sideSpecs[1]?.name!=='No') return [];
    const p=fields(q.description);
    const deadline=stamp(p?.get('resolutionDeadline') || p?.get('expiry') || p?.get('decisionDeadline'));
    if (!Number.isFinite(deadline) || deadline<=now ||
        (p?.has('scheduledStart') && (!Number.isFinite(stamp(p.get('scheduledStart'))) || stamp(p.get('scheduledStart'))<=now))) return [];
    const omitFallback=sportsThreeWay(q,named,fallback,templateById) || policyThreeWay(q,named,fallback,templateById);
    const covered=omitFallback?named:[...named,fallback];
    if (covered.length>MAX_COMPLETE_SET_LEGS ||
        (covered.length===9 && !reviewedTournament(q,named,fallback,templateById))) return [];
    const source={question:q, covered:covered.map(o=>({id:o.outcome,name:o.name,description:o.description,scale:o.deployerFeeScale})),
      template:templateById.get(q.name?.slice(9)), children:covered.map(o=>templateById.get(o.name?.slice(9)) ?? null)};
    return [{...q, outcomes:covered, coveredIds:covered.map(o=>o.outcome),
      coverage:omitFallback?'named_exhaustive':'with_fallback', ruleDigest:digest(source),
      ruleSource:'https://api.hyperliquid.xyz/info:outcomeMeta+outcomeTemplates'}];
  });
}
