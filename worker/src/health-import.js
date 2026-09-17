// Health Auto Export JSON v2. Only selected daily totals and workout summaries
// are retained; raw samples, GPS routes and unrelated health data are discarded.
const round = n => Math.round(n * 100) / 100;
const number = (n, label) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new Error(`Invalid ${label}`);
  return n;
};
function day(value) {
  if (typeof value !== 'string') throw new Error('Missing Health date');
  const iso = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || new Date(iso+'T00:00:00Z').toISOString().slice(0,10)!==iso) throw new Error('Invalid Health date');
  return iso; // Preserve the calendar day recorded with the device's time zone.
}
function quantity(value, units, label) {
  if (value == null) return undefined;
  const multiplier=units[value.units];
  if (multiplier === undefined) throw new Error(`Unsupported ${label} unit`);
  return round(number(value.qty,label)*multiplier);
}
export function normalizeHealthExport(payload) {
  const data=payload?.data ?? payload;
  if (!data || (!Array.isArray(data.metrics) && !Array.isArray(data.workouts))) throw new Error('Expected Health Auto Export metrics or workouts');
  const days={};
  const get=date => days[date] ??= {bio:{},workouts:[]};
  const mappings={step_count:['steps',{count:1}],active_energy:['activeKcal',{kcal:1,kJ:1/4.184}],resting_heart_rate:['restingHr',{bpm:1,'count/min':1}], 'weight_&_body_mass':['weightKg',{kg:1,lb:0.45359237}]};
  for(const metric of data.metrics||[]) {
    const map=mappings[metric.name];
    if (!map) continue;
    if (!Array.isArray(metric.data)) throw new Error('Invalid metric samples');
    for(const sample of metric.data) {
      const dest=get(day(sample.date));
      if(map[0] in dest.bio) throw new Error('Export one daily summary per metric: enable Summarize Data, Days and preferred Garmin source');
      dest.bio[map[0]]=quantity({qty:sample.qty,units:metric.units},map[1],map[0]);
    }
  }
  const ids=new Set();
  for(const w of data.workouts||[]) {
    if(typeof w.id!=='string'||!w.id||w.id.length>200) throw new Error('Use workout export Version 2 with IDs');
    if(ids.has(w.id)) continue;
    ids.add(w.id);
    if(typeof w.name!=='string'||!w.name.trim()||w.name.length>80) throw new Error('Missing workout activity');
    const dest=get(day(w.start));
    const entry={id:w.id,type:w.name.trim(),minutes:round(number(w.duration,'workout duration')/60),start:w.start,importedFrom:'apple-health'};
    const calories=quantity(w.activeEnergyBurned,{kcal:1,kJ:1/4.184},'workout calories');
    const distance=quantity(w.distance,{km:1,mi:1.609344,m:0.001},'workout distance');
    if(calories!==undefined)entry.calories=calories;
    if(distance!==undefined)entry.distanceKm=distance;
    dest.workouts.push(entry);
  }
  if(Object.keys(days).length>31)throw new Error('Export no more than 31 days per request');
  return days;
}
export function mergeHealthDay(previous,date,patch) {
  const next=structuredClone(previous||{date});
  next.bio={...next.bio,...patch.bio};
  if(patch.workouts.length) {
    const entries=Array.isArray(next.workouts)?next.workouts.slice():[];
    for(const incoming of patch.workouts) {
      const at=entries.findIndex(w=>w.id===incoming.id);
      if(at<0) entries.push(incoming); else entries[at]=incoming;
    }
    if(entries.length>5)throw new Error(`More than five workouts on ${date}; no entries were discarded`);
    next.workouts=entries.sort((a,b)=>(a.start||'').localeCompare(b.start||''));
    next.bio.walkingMin=round(entries.filter(w=>/^walking$|^indoor walk(?:ing)?$|^outdoor walk(?:ing)?$/i.test(w.type)).reduce((sum,w)=>sum+(w.minutes||0),0));
  }
  return next;
}
