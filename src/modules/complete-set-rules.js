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

/** Derive candidates from current official metadata and template texts, never market IDs. */
export function completeSetQuestions(meta, templates, now=Date.now()) {
  if (!Array.isArray(meta?.questions) || !Array.isArray(meta?.outcomes) || !Array.isArray(templates)) return [];
  const byId=new Map(meta.outcomes.map(o=>[o?.outcome,o]));
  const templateById=new Map(templates.map(t=>[t?.id,t]));
  return meta.questions.flatMap(q=>{
    const ids=q?.namedOutcomes;
    if (!Number.isSafeInteger(q?.question) || !Array.isArray(ids) || ids.length<2 || ids.length>8 ||
      !ids.every(Number.isSafeInteger) || new Set(ids).size!==ids.length || ids.includes(q.fallbackOutcome) ||
      !Number.isSafeInteger(q.fallbackOutcome) || !Array.isArray(q.settledNamedOutcomes) || q.settledNamedOutcomes.length ||
      q.settledFallbackOutcome != null) return [];
    const named=ids.map(id=>byId.get(id)), fallback=byId.get(q.fallbackOutcome);
    if (named.some(o=>o?.quoteToken!=='USDC' || !Array.isArray(o.sideSpecs) || o.sideSpecs[0]?.name!=='Yes' || o.sideSpecs[1]?.name!=='No') ||
      fallback?.quoteToken!=='USDC' || !Array.isArray(fallback.sideSpecs) || fallback.sideSpecs[0]?.name!=='Yes' || fallback.sideSpecs[1]?.name!=='No') return [];
    const p=fields(q.description);
    const deadline=stamp(p?.get('resolutionDeadline') || p?.get('expiry'));
    if (!Number.isFinite(deadline) || deadline<=now ||
        (p?.has('scheduledStart') && (!Number.isFinite(stamp(p.get('scheduledStart'))) || stamp(p.get('scheduledStart'))<=now))) return [];
    const omitFallback=sportsThreeWay(q,named,fallback,templateById);
    const covered=omitFallback?named:[...named,fallback];
    if (covered.length>8) return [];
    const source={question:q, covered:covered.map(o=>({id:o.outcome,name:o.name,description:o.description,scale:o.deployerFeeScale})),
      template:templateById.get(q.name?.slice(9)), children:covered.map(o=>templateById.get(o.name?.slice(9)) ?? null)};
    return [{...q, outcomes:covered, coveredIds:covered.map(o=>o.outcome),
      coverage:omitFallback?'named_exhaustive':'with_fallback', ruleDigest:digest(source),
      ruleSource:'https://api.hyperliquid.xyz/info:outcomeMeta+outcomeTemplates'}];
  });
}
