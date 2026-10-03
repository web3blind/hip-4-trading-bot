import {formatTemplateTitle, formatPriceBinaryDescription, getPriceBucketOutcomeLabel} from '../bot/ui/formatters.js';

// Presentation only: never mutate metadata used for source membership/fingerprints.
const clean = value => String(value ?? '').replace(/[<>\x00-\x1f]/g, '').trim();
const readable = value => {
  const text=clean(value);
  return text && !/template:|[{}]/.test(text) ? text : null;
};
const fields = description => Object.fromEntries(String(description || '').split('|').map(part => {
  const i=part.indexOf(':');return i>0?[part.slice(0,i),part.slice(i+1)]:[];
}).filter(part=>part.length===2));
const kinds={
  sportsContestWinner:'Contest winner', sportsContestResult:'Contest result',
  sportsContestParticipant2:'Contest participant',sportsContestDraw2:'Draw',
  sportsTournamentWinner:'Tournament winner',sportsTournamentParticipant:'Tournament participant',
  sportsOverUnderMarket:'Over/under',policyRateDecision:'Rate decision',
  policyRateNoChange:'No change',policyRateDecrease:'Decrease',policyRateIncrease:'Increase',
  companyIpoConfirmed:'IPO confirmed',
};
function startDate(value) {
  const m=/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(value || ''));
  if(!m)return null;
  const iso=`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z`,date=new Date(iso);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==iso)return null;
  return new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:'UTC'}).format(date).replace(',','')+' UTC';
}
export function formatSportsTemplate(name, description) {
  const kind=String(name || '').replace(/^template:/,'');
  if(!kind.startsWith('sports'))return null;
  const p=fields(description),a=readable(p.participantA),b=readable(p.participantB);
  // Constituent outcomes retain their own identity, not the parent match title.
  if(kind==='sportsContestDraw2')return 'Draw';
  if(['sportsContestParticipant2','sportsTournamentParticipant'].includes(kind))return readable(p.participant);
  // Teams first so bounded Telegram buttons retain the distinguishing information.
  if(a && b)return [a+' — '+b,readable(p.competition),startDate(p.scheduledStart)].filter(Boolean).join(' · ');
  if(p.competition && kind==='sportsTournamentWinner')return [readable(p.competition),readable(p.season),kinds[kind]].filter(Boolean).join(' · ');
  return null;
}
export function liquidityName(spec, question, fallback=false) {
  if(fallback)return 'Fallback';
  const p={...fields(question?.description),...fields(spec?.description)},kind=String(spec?.name || '').replace(/^template:/,'');
  const id=spec?.outcome ?? spec?.question;
  const sports=formatSportsTemplate(spec?.name,Object.entries(p).map(([k,v])=>`${k}:${v}`).join('|'));
  if(sports)return sports;
  if(kind==='policyRateDecision')return [readable(p.decisionLabel),readable(p.institution),'Rate decision'].filter(Boolean).join(' · ');
  if(['policyRateNoChange','policyRateDecrease','policyRateIncrease'].includes(kind))return kinds[kind];
  if(question?.description?.startsWith('class:priceBucket')){
    const bucket=getPriceBucketOutcomeLabel(question.description,spec?.description);if(bucket)return bucket;
  }
  const binary=formatPriceBinaryDescription(spec?.description);if(binary)return binary.split('\n')[0];
  if(['priceTouch','binaryPrice'].includes(kind))return formatTemplateTitle(spec.name,spec.description);
  const source=readable(spec?.displayName) || readable(spec?.name);
  if(source)return source;
  return `${kinds[kind] || 'Event'} #${id ?? '?'}`;
}
export function liquiditySideName(spec, side, question) {
  const raw=clean(spec?.sideSpecs?.[side]?.name);
  const p={...fields(question?.description),...fields(spec?.description)};
  if(!raw && spec?.name==='template:sportsContestWinner')return readable(p[side===0?'participantA':'participantB']) || `Side ${side+1}`;
  if(!raw)return side===0?'YES':'NO';
  if(/^(yes|no)$/i.test(raw))return raw.toUpperCase();
  if(!raw.startsWith('template:'))return readable(raw) || `Side ${side+1}`;
  const ref=/^template:\{([^{}]+)\}$/.exec(raw)?.[1];
  if(['shortNameA','shortNameB'].includes(ref))return readable(p[ref.replace('shortName','participant')]) || readable(p[ref]) || `Side ${side+1}`;
  return (ref && readable(p[ref])) || `Side ${side+1}`;
}
export const liquidityDisplaySide = (name,t) => /^(YES|NO)$/i.test(name || '') ? t(name.toUpperCase()==='YES'?'yes':'no') : /^Side [12]$/.test(name || '') ? `${t('side')} ${name.slice(-1)}` : name;
