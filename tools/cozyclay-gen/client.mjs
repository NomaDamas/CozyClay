// cozyclay-gen client (Node 18+ / browser). Drop into CozyClay next to the bake client.
//
//   import { generateH3 } from './client.mjs'
//   const { mp4Url, wallSeconds } = await generateH3({
//     base: 'http://localhost:8288',
//     prompt,                      // official H3 contract text (see h3_prompts.py / skill)
//     refs: [pngBlob],             // Ref2VA: pose/camera refs (CozyClay render)
//     // first: pngBlob, last: pngBlob   // or I2V / FL2V
//     seconds: 15, megapixels: 0.4, aspect: '16:9', seed: 42, steps: 4,
//   })
//   video.src = mp4Url

export async function generateH3({ base = 'http://localhost:8288', prompt, refs = [], first, last,
  seconds = 5, megapixels = 0.4, aspect = '16:9', seed = 42, steps = 4, audio = false, signal } = {}) {
  const fd = new FormData();
  fd.append('prompt', prompt);
  fd.append('seconds', String(seconds));
  fd.append('megapixels', String(megapixels));
  fd.append('aspect', aspect);
  fd.append('seed', String(seed));
  fd.append('steps', String(steps));
  fd.append('audio', audio ? '1' : '0');
  fd.append('mode', refs.length ? 'ref' : 'i2v');
  refs.forEach((b, i) => fd.append('ref', b, `ref_${i}.png`));
  if (first) fd.append('first', first, 'first.png');
  if (last) fd.append('last', last, 'last.png');
  const r = await fetch(`${base}/generate`, { method: 'POST', body: fd, signal });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return { ...j, mp4Url: `${base}${j.mp4}`, wallSeconds: j.wall_seconds };
}

export async function health(base = 'http://localhost:8288') {
  const r = await fetch(`${base}/health`);
  return r.json();
}
