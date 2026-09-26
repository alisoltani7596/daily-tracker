import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/src/index.js';

// Vancouver dates, computed the way the Worker does.
const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'America/Vancouver', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const y = new Date(today + 'T12:00:00Z'); y.setUTCDate(y.getUTCDate() - 1);
const yesterday = y.toISOString().slice(0, 10);

// Runs one chat turn against a mocked Anthropic API; returns the system blocks it received.
async function chatSystem(path, kv) {
  const env = {ANTHROPIC_API_KEY: 'test', ALLOWED_ORIGINS: 'https://example', TODAY_KV: {get: async k => { if (kv instanceof Error) throw kv; return kv.get(k) ?? null; }}};
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({content: [{type: 'text', text: 'ok'}], stop_reason: 'end_turn'}), {status: 200}); };
  try {
    const res = await worker.fetch(new Request('https://example' + path, {method: 'POST', headers: {origin: 'https://example'}, body: JSON.stringify({messages: [{role: 'user', content: 'hi'}], context: 'tracker_state: x'})}), env);
    assert.equal(res.status, 200);
  } finally { globalThis.fetch = realFetch; }
  return sent.system.map(b => b.text);
}

test('coach and planner both receive health from the Shortcut sample and the Health log', async () => {
  const kv = new Map([
    ['health:' + today, JSON.stringify({steps: 900, sleep_hours: 6.5, bed_time: '00:40', wake_time: '07:10', sleep_score_computed: 71, sleep_stages: {deep: 50, core: 240, rem: 80, awake: 20}})],
    ['workout:' + today, JSON.stringify({date: today, tier: 'must', rpe: 6, bio: {steps: 4210, activeKcal: 310, restingHr: 54, weightKg: 93.1, walkingMin: 25}, workouts: [{type: 'Walking', minutes: 25, calories: 120, distanceKm: 2.1}]})],
    ['health:' + yesterday, JSON.stringify({steps: 7000, workouts: [{type: 'Football', minutes: 60}]})],
  ]);
  for (const path of ['/', '/plan']) {
    const system = await chatSystem(path, kv);
    assert.equal(system[1], 'tracker_state: x');
    assert.equal(system[2], [
      'health_data (Apple Health / Garmin, Vancouver dates):',
      `  today ${today} (so far):`,
      '    sleep: 6.5h (00:40 → 07:10)',
      '    sleep score: 71 (iris)',
      '    sleep stages (min): deep 50, core 240, rem 80, awake 20',
      '    steps: 4210',
      '    active kcal: 310',
      '    resting HR: 54 bpm',
      '    weight: 93.1 kg',
      '    walking: 25 min',
      '    workouts: Walking 25 min · 120 kcal · 2.1 km',
      '    program session: done (MUST, the short floor version) · RPE 6',
      `  yesterday ${yesterday}:`,
      '    steps: 7000',
      '    workouts: Football 60 min',
    ].join('\n') + '\n');
  }
});

test('an empty health store is stated rather than left for the model to guess', async () => {
  for (const path of ['/', '/plan']) {
    const system = await chatSystem(path, new Map([['health:2020-01-01', JSON.stringify({steps: 1})]]));
    assert.equal(system[2], 'health_data (Apple Health / Garmin): nothing synced for today or yesterday\n');
  }
});

test('a health store failure never fails the chat turn', async () => {
  for (const path of ['/', '/plan']) {
    const system = await chatSystem(path, new Error('KV down'));
    assert.equal(system.length, 2);
  }
});
