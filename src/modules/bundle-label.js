// Derive event titles from the parent question or the saved constituent outcomes,
// never from one outcome's display title.
const participant = description => /^participant:([^|]+)$/.exec(String(description || ''))?.[1]?.trim() || null;
const fields = description => Object.fromEntries(String(description || '').split('|').map(part => {
  const i = part.indexOf(':');
  return i > 0 ? [part.slice(0, i), part.slice(i + 1)] : [];
}).filter(part => part.length === 2));

export function bundleEventLabel(snapshot, outcomes = [], meta = null) {
  const question = meta?.questions?.find(q => q.question === snapshot.questionId);
  const match = question && Array.isArray(question.namedOutcomes) &&
    snapshot.coins?.every(coin => question.namedOutcomes.includes(Number(coin.slice(1)) / 10));
  if (match) {
    const values = fields(question.description);
    if (values.participantA && values.participantB && values.participantA !== values.participantB)
      return `${values.participantA} — ${values.participantB}`;
    if (question.name && !question.name.startsWith('template:')) return question.name;
  }
  const participants = outcomes.map(o => participant(o?.description)).filter(Boolean);
  if (participants.length === 2 && participants[0] !== participants[1]) return participants.join(' — ');
  const old = String(snapshot.label || '').trim();
  // Keep a meaningful historical event name, but not a stale first-leg label.
  if (old && !outcomes.some(o => o?.question === old) && !/^Contest participant\b/i.test(old)) return old;
  return `#${snapshot.questionId}`;
}

const regions = new Map();
let indexed = false;
export function localizeBundleLabel(label, language) {
  if (language !== 'ru' || !label) return label;
  if (!indexed) {
    indexed = true;
    const en = new Intl.DisplayNames(['en'], {type:'region'});
    const ru = new Intl.DisplayNames(['ru'], {type:'region'});
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b), name = en.of(code);
      if (name !== code) regions.set(name.toLowerCase(), ru.of(code));
    }
  }
  return label.split(' — ').map(name => regions.get(name.toLowerCase()) || name).join(' — ');
}
