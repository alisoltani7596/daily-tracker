import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeHealthExport,mergeHealthDay} from '../worker/src/health-import.js';
import worker from '../worker/src/index.js';
const cycling={id:'cycling-1',name:'Cycling',start:'2026-09-15 23:10:00 -0700',end:'2026-09-15 23:32:00 -0700',duration:1320,activeEnergyBurned:{qty:39,units:'kcal'},distance:{qty:.34,units:'km'}};
test('automatic workout import retains the local day, correct units and deduplicates',()=>{
 const result=normalizeHealthExport({data:{workouts:[cycling,cycling]}});
 assert.equal(Object.keys(result)[0],'2026-09-15');
 assert.equal(result['2026-09-15'].workouts.length,1);
 assert.deepEqual(result['2026-09-15'].workouts[0],{id:'cycling-1',type:'Cycling',minutes:22,start:cycling.start,importedFrom:'apple-health',calories:39,distanceKm:.34});
 const a=mergeHealthDay({date:'2026-09-15',notes:'Keep me',bio:{sleepScore:88}},'2026-09-15',result['2026-09-15']);
 assert.equal(a.notes,'Keep me');assert.equal(a.bio.sleepScore,88);assert.equal(a.bio.walkingMin,0);
 assert.deepEqual(mergeHealthDay(a,'2026-09-15',result['2026-09-15']),a);
});
test('walking minutes include walking workouts only and repeated exports update them',()=>{
 const patch=normalizeHealthExport({workouts:[cycling,{...cycling,id:'walk',name:'Walking',duration:1500,distance:{qty:1,units:'mi'}}]})['2026-09-15'];
 const a=mergeHealthDay(null,'2026-09-15',patch);assert.equal(a.bio.walkingMin,25);assert.equal(a.workouts[1].distanceKm,1.61);
 patch.workouts[1].minutes=30;assert.equal(mergeHealthDay(a,'2026-09-15',patch).bio.walkingMin,30);
});
test('ambiguous unaggregated metrics and invalid units fail instead of inflating totals',()=>{
 const m={name:'step_count',units:'count',data:[{qty:3695,date:'2026-09-15'}]};
 assert.equal(normalizeHealthExport({metrics:[m]})['2026-09-15'].bio.steps,3695);
 assert.throws(()=>normalizeHealthExport({metrics:[{...m,data:[...m.data,...m.data]}]}),/daily summary/);
 assert.throws(()=>normalizeHealthExport({workouts:[{...cycling,distance:{qty:3,units:'yards'}}]}),/unit/);
 assert.throws(()=>normalizeHealthExport({workouts:[{...cycling,duration:-1}]}),/duration/);
 assert.throws(()=>mergeHealthDay(null,'2026-09-15',{bio:{},workouts:Array.from({length:6},(_,i)=>({id:String(i),type:'Cycling',minutes:1}))}),/five/);
});
test('native import requires authentication, is idempotent and does not save raw routes',async()=>{
 const kv=new Map();let writes=0;
 const env={EDIT_TOKEN:'test',ALLOWED_ORIGINS:'https://example',TODAY_KV:{get:async k=>kv.get(k)||null,put:async(k,v)=>{kv.set(k,v);writes++;}}};
 const send=(headers,body)=>worker.fetch(new Request('https://example/health-import',{method:'POST',headers,body:JSON.stringify(body)}),env);
 assert.equal((await send({}, {data:{workouts:[cycling]}})).status,403);
 assert.equal((await send({'x-edit-token':'test',origin:'https://wrong'},{data:{workouts:[cycling]}})).status,403);
 const payload={data:{workouts:[{...cycling,route:[{lat:10,lon:20}]}]}};
 assert.equal((await send({'x-edit-token':'test'},payload)).status,200);
 assert.equal((await send({'x-edit-token':'test'},payload)).status,200);assert.equal(writes,1);
 assert.equal(kv.get('workout:2026-09-15').includes('route'),false);
 assert.equal((await send({'x-edit-token':'test'},{data:{workouts:[]}})).status,200);assert.equal(writes,1);
});
