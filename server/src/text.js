// Tokens for guide matching and doc retrieval: lowercase, no punctuation, no stopwords,
// light stemming so "issues", "logging" and "boxes" meet "issue", "log" and "box".

const STOPWORDS = new Set(`
  a an the how do does did doing done i im me my mine we us our you your yours
  show tell can could would should will shall may might must please pls
  to of for in on at by with from into onto about as up out over
  is are am was were be been being it its this that these those there here
  and or but so if then than also just like
  what whats which who whom whose where when why
  some any get got want wanna need let lets dont use uses used using
`.split(/\s+/).filter(Boolean));

export function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (/(xes|ches|shes|sses|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);

  let stripped = false;
  if (w.length > 5 && w.endsWith('ing')) { w = w.slice(0, -3); stripped = true; }
  else if (w.length > 4 && w.endsWith('ed')) { w = w.slice(0, -2); stripped = true; }
  // logg -> log, runn -> run (but add stays add; fill, pass and buzz keep their pairs)
  if (stripped && w.length > 3 && /([b-df-hj-km-np-rtv-y])\1$/.test(w)) w = w.slice(0, -1);

  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1); // create/creating -> creat
  return w;
}

export function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

export function normalise(text) {
  return tokens(text).join(' ');
}
