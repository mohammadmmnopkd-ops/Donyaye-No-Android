const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || 'Iran_2626';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {fileURLToPath} from 'url';
import 'dotenv/config';
import OpenAI from 'openai';

const __filename=fileURLToPath(import.meta.url); const __dirname=path.dirname(__filename);
const app=express(); const PORT=Number(process.env.PORT||10000);
const DATA=path.join(__dirname,'data'); fs.mkdirSync(DATA,{recursive:true});
const DB=path.join(DATA,'game-db.json');
const PUBLIC=path.join(__dirname,'public');
const AI_GROUP_PASSWORD = process.env.AI_GROUP_PASSWORD || 'Iran_2626';
const openai=process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null;
const MODEL=process.env.OPENAI_MODEL||'gpt-5.6-luna';
const HUMAN_MAX=Number(process.env.WORLD_MAX_HUMANS||100);
const PAYOUT_MS=10*60*1000;
const RECRUIT_MS=24*60*60*1000;
const AI_TICK_MS=60*1000;
const AI_MODEL_INTERVAL_MS=10*60*1000;
const ACTIVE_TIMEOUT_MS=2*60*1000;

function now(){return Date.now()}
function iso(t=now()){return new Date(t).toISOString()}
function safeNum(v,d=0){const n=Number(v);return Number.isFinite(n)?n:d}
function save(db){fs.writeFileSync(DB,JSON.stringify(db,null,2))}
function load(){try{return JSON.parse(fs.readFileSync(DB,'utf8'))}catch{return {version:4,players:{},worlds:[],lastWorldCreatedAt:0}}}
let db=load();

function countryPool(){
  try{
    const html=fs.readFileSync(path.join(PUBLIC,'index.html'),'utf8');
    const m=html.match(/window\.WORLD_DATA\s*=\s*(\{.*?\});/s);
    if(m){const data=JSON.parse(m[1]);const names=(data.features||[]).map(f=>f?.properties?.name).filter(Boolean);if(names.length)return [...new Set(names)]}
  }catch(e){console.error('country pool load failed',e.message)}
  return ['Iran','United States of America','Russia','China','Germany','France','United Kingdom','Japan','Brazil','India','Turkey','Italy','Spain','Canada','Australia','Egypt','Saudi Arabia','South Korea','Mexico','Argentina'];
}
const COUNTRY_POOL=countryPool();
const COUNTRY_SET=new Set(COUNTRY_POOL);

function emptyWorld(id){const created=now();return {id,name:`World ${id}`,createdAt:iso(created),recruitmentEndsAt:iso(created+RECRUIT_MS),phase:'recruiting',humans:[],bots:[],countries:{},chat:[],lastAITickAt:created,lastAIModelAt:0}}
function migrateWorld(w){
  w.humans=Array.isArray(w.humans)?w.humans:(Array.isArray(w.players)?w.players:[]);
  w.bots=Array.isArray(w.bots)?w.bots:[];
  w.countries=w.countries||{};
  w.chat=Array.isArray(w.chat)?w.chat:[];
  w.createdAt=w.createdAt||iso();
  w.recruitmentEndsAt=w.recruitmentEndsAt||iso(new Date(w.createdAt).getTime()+RECRUIT_MS);
  w.phase=w.phase||'recruiting';
  w.lastAITickAt=safeNum(w.lastAITickAt,now());
  w.lastAIModelAt=safeNum(w.lastAIModelAt,0);
  return w;
}
if(!Array.isArray(db.worlds)||!db.worlds.length){db.worlds=[emptyWorld(1)];db.lastWorldCreatedAt=now();save(db)}
for(const w of db.worlds)migrateWorld(w);
for(const p of Object.values(db.players||{})){
  p.lastSeen=safeNum(p.lastSeen,now());
  p.lastPayoutAt=safeNum(p.lastPayoutAt,now());
  p.money=safeNum(p.money,0);p.gems=safeNum(p.gems,0);p.soldiers=safeNum(p.soldiers,0);p.fighters=safeNum(p.fighters,0);p.ships=safeNum(p.ships,0);p.weapons=safeNum(p.weapons,0);
  p.isAI=Boolean(p.isAI);p.aiState=p.aiState||{};
}
save(db);

function getWorld(id){return db.worlds.find(w=>w.id===Number(id))}
function humanCount(w){return w.humans.length}
function botCount(w){return w.bots.length}
function usedCountry(w,c){return Boolean(w.countries[c])}
function onlineCount(w){return [...w.humans,...w.bots].filter(id=>{const p=db.players[id];return p&&now()-p.lastSeen<ACTIVE_TIMEOUT_MS}).length}
function allParticipantIds(w){return [...w.humans,...w.bots]}
function ensurePhase(w){
  if(w.phase==='recruiting' && now()>=new Date(w.recruitmentEndsAt).getTime()){
    w.phase='active';
    fillAIBots(w);
    save(db);
  }
}
function maybeCreateWorld(){
  const last=db.worlds.at(-1); if(!last)return;
  if(now()-new Date(last.createdAt).getTime()>=RECRUIT_MS){
    const id=last.id+1;
    if(!db.worlds.some(w=>w.id===id)){db.worlds.push(emptyWorld(id));db.lastWorldCreatedAt=now();save(db)}
  }
}

function newPlayer(worldId,country,isAI=false){
  const id=crypto.randomUUID();
  const p={id,worldId,country,money:0,gems:0,soldiers:0,fighters:0,ships:0,weapons:0,createdAt:iso(),lastSeen:now(),lastPayoutAt:now(),isAI,aiState:{priority:'economy',lastAction:null,plan:null}};
  db.players[id]=p;
  const w=getWorld(worldId); (isAI?w.bots:w.humans).push(id); w.countries[country]=id;
  return p;
}

function playerPublic(p){return {...p,aiState:p.isAI?{priority:p.aiState?.priority||'economy',lastAction:p.aiState?.lastAction||null}:undefined}}

function payoutPlayer(p){
  const elapsed=Math.max(0,now()-safeNum(p.lastPayoutAt,now()));
  const ticks=Math.floor(elapsed/PAYOUT_MS);
  if(ticks>0){p.money+=ticks*3000;p.lastPayoutAt += ticks*PAYOUT_MS;return ticks}
  return 0;
}
function payoutAll(){for(const p of Object.values(db.players)){payoutPlayer(p)}}

function fillAIBots(w){
  if(w.phase!=='active')return;
  for(const country of COUNTRY_POOL){
    if(usedCountry(w,country))continue;
    const p=newPlayer(w.id,country,true);
    p.aiState.priority='economy';
  }
}

function aiChooseAction(p,w){
  const priority=p.aiState?.priority||'economy';
  const actions=[];
  const money=p.money;
  const add=(type,cost,score)=>actions.push([type,cost,score]);
  if(priority==='military'){
    if(money>=600 && p.soldiers<2000)add('army',600,1);
    if(money>=600 && p.weapons<5)add('weapons',600,2);
    if(money>=12000 && p.fighters<4)add('fighter',12000,3);
  }else if(priority==='air'){
    if(money>=12000 && p.fighters<6)add('fighter',12000,1);
    if(money>=600 && p.weapons<4)add('weapons',600,2);
  }else if(priority==='navy'){
    if(money>=18000 && p.ships<4)add('ship',18000,1);
    if(money>=600 && p.weapons<4)add('weapons',600,2);
  }else{
    if(money>=2500)add('economy',2500,1);
    if(money>=600 && p.weapons<3)add('weapons',600,3);
    if(money>=600 && p.soldiers===0)add('army',600,4);
  }
  actions.sort((a,b)=>a[2]-b[2]);
  const pick=actions[0];
  if((p.soldiers||0)===0 && money>=600){actions.push(['army',600]);}
  if((p.weapons||0)<3 && money>=600)actions.push(['weapons',600]);
  if(money>=12000 && (p.fighters||0)<1)actions.push(['fighter',12000]);
  if(money>=18000 && (p.ships||0)<1)actions.push(['ship',18000]);
  if(money>=2500){actions.push(['economy',2500]);}
  if(!pick)return null;
  const [type,cost]=pick;
  if(type==='army'){p.money-=cost;p.soldiers+=(500);p.aiState.priority='military';p.aiState.lastAction='خرید ۵۰۰ سرباز'}
  else if(type==='weapons'){p.money-=cost;p.weapons+=1;p.aiState.priority='military';p.aiState.lastAction='ارتقای تسلیحات'}
  else if(type==='fighter'){p.money-=cost;p.fighters+=1;p.aiState.priority='air';p.aiState.lastAction='خرید جنگنده'}
  else if(type==='ship'){p.money-=cost;p.ships+=1;p.aiState.priority='navy';p.aiState.lastAction='ساخت ناو'}
  else {p.money-=cost;p.aiState.priority='economy';p.aiState.lastAction='سرمایه‌گذاری اقتصادی'}
  return p.aiState.lastAction;
}

function runAIBasic(w){
  ensurePhase(w); if(w.phase!=='active')return;
  for(const id of w.bots){const p=db.players[id];if(!p)continue;payoutPlayer(p);aiChooseAction(p,w);p.lastSeen=now()}
  w.lastAITickAt=now();
}

async function runAIModelPlanner(w){
  if(!openai||w.phase!=='active'||now()-w.lastAIModelAt<AI_MODEL_INTERVAL_MS)return;
  const bots=w.bots.map(id=>db.players[id]).filter(Boolean).slice(0,20);
  if(!bots.length)return;
  const snapshot=bots.map(p=>({country:p.country,money:p.money,soldiers:p.soldiers,fighters:p.fighters,ships:p.ships,weapons:p.weapons,priority:p.aiState?.priority||'economy'}));
  try{
    const r=await openai.responses.create({model:MODEL,input:[
      {role:'developer',content:'تو فرمانده هوش مصنوعی بازی استراتژیک دنیای نو هستی. برای هر کشور AI فقط یک اولویت کوتاه انتخاب کن: economy, military, air, navy, diplomacy. خروجی فقط JSON معتبر با کلید plans و آرایه‌ای از {country,priority} بده. هیچ توضیح اضافه نده.'},
      {role:'user',content:JSON.stringify({world:w.name,phase:w.phase,bots:snapshot})}
    ]});
    const raw=r.output_text||''; const parsed=JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0]||raw);
    for(const plan of parsed.plans||[]){const p=bots.find(x=>x.country===plan.country);if(p&&['economy','military','air','navy','diplomacy'].includes(plan.priority))p.aiState.priority=plan.priority}
    w.lastAIModelAt=now();
  }catch(e){console.error('AI planner',e.message)}
}

function aiStatus(){return {configured:Boolean(openai),model:MODEL,groupConfigured:Boolean(AI_GROUP_PASSWORD),autonomousBots:db.worlds.reduce((n,w)=>n+w.bots.length,0),worlds:db.worlds.length}}

async function gameTick(){
  maybeCreateWorld(); payoutAll();
  for(const w of db.worlds){ensurePhase(w);runAIBasic(w);await runAIModelPlanner(w)}
  save(db);
}


// Android/WebView client access: allow the packaged game client to call the API.
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, X-AI-Group-Password');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({limit:'256kb'}));

function aiAuth(req,res){const supplied=String(req.get('X-AI-Group-Password')||'');if(!AI_GROUP_PASSWORD)return res.status(503).json({error:'AI_GROUP_PASSWORD تنظیم نشده است'}),false;const a=Buffer.from(supplied),b=Buffer.from(AI_GROUP_PASSWORD);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(403).json({error:'رمز گروه AI اشتباه است'}),false;return true}

app.get('/api/ai-status',(req,res)=>res.json(aiStatus()));

// Private management / AI-group authentication. Password is checked server-side only.
app.post('/api/admin/login',(req,res)=>{
  const password=String(req.body?.password||'');
  if(password!==ADMIN_PANEL_PASSWORD)return res.status(401).json({ok:false,error:'invalid password'});
  res.json({ok:true,role:'admin',message:'پنل مدیریت فعال شد'});
});
app.post('/api/ai-team/login',(req,res)=>{
  const password=String(req.body?.password||'');
  if(password!==AI_GROUP_PASSWORD)return res.status(401).json({ok:false,error:'invalid password'});
  res.json({ok:true,role:'ai-manager',message:'گروه هوش مصنوعی فعال شد'});
});
app.get('/api/ai-team/status',(req,res)=>res.json({...aiStatus(),worldBots:db.worlds.map(w=>({worldId:w.id,name:w.name,bots:w.bots.length,phase:w.phase}))}));
app.post('/api/ai-team',async(req,res)=>{if(!aiAuth(req,res))return;if(!openai)return res.status(503).json({error:'OPENAI_API_KEY تنظیم نشده است'});const task=String(req.body?.task||'').slice(0,12000).trim();if(!task)return res.status(400).json({error:'درخواست AI خالی است'});try{const r=await openai.responses.create({model:MODEL,input:[{role:'developer',content:'تو AI HQ بازی دنیای نو هستی. فقط برنامه، گزارش، ریسک و پیشنهاد فنی بده؛ کلیدها و رمزها را نمایش نده و فایل بازی را خودکار تغییر نده.'},{role:'user',content:task}]});res.json({ok:true,model:MODEL,report:r.output_text||''})}catch(e){res.status(500).json({ok:false,error:String(e?.message||e)})}});

app.get('/api/health',(req,res)=>res.json({ok:true,online:true,serverAuthoritative:true,ai:aiStatus(),worlds:db.worlds.length}));
app.get('/api/worlds',(req,res)=>{maybeCreateWorld();for(const w of db.worlds)ensurePhase(w);res.json({worlds:db.worlds.map(w=>({id:w.id,name:w.name,players:humanCount(w),maxPlayers:HUMAN_MAX,countries:Object.keys(w.countries).length,maxCountries:COUNTRY_POOL.length,online:onlineCount(w),bots:botCount(w),phase:w.phase,status:w.phase==='recruiting'?(humanCount(w)>=HUMAN_MAX?'full':'open'):'active',createdAt:w.createdAt,recruitmentEndsAt:w.recruitmentEndsAt}))})});
app.get('/api/world/:id',(req,res)=>{const w=getWorld(req.params.id);if(!w)return res.status(404).json({error:'world not found'});ensurePhase(w);res.json({id:w.id,name:w.name,players:humanCount(w),maxPlayers:HUMAN_MAX,countries:Object.keys(w.countries),maxCountries:COUNTRY_POOL.length,online:onlineCount(w),bots:botCount(w),phase:w.phase,recruitmentEndsAt:w.recruitmentEndsAt})});

app.post('/api/session',(req,res)=>{
  const {worldId,country}=req.body||{}; const w=getWorld(worldId); if(!w)return res.status(404).json({error:'world not found'}); ensurePhase(w);
  if(w.phase!=='recruiting')return res.status(409).json({error:'مهلت ۲۴ ساعته انتخاب بازیکن تمام شده و سرور فعال است',phase:w.phase});
  if(!country||typeof country!=='string')return res.status(400).json({error:'country required'});
  if(!COUNTRY_SET.has(country))return res.status(400).json({error:'کشور نامعتبر است'});
  if(usedCountry(w,country))return res.status(409).json({error:'کشور قبلاً انتخاب شده است',country,available:COUNTRY_POOL.filter(c=>!usedCountry(w,c)).slice(0,100)});
  if(humanCount(w)>=HUMAN_MAX)return res.status(409).json({error:'ظرفیت بازیکنان واقعی این سرور پر است'});
  const p=newPlayer(w.id,country,false);save(db);res.json({ok:true,player:playerPublic(p),world:{id:w.id,name:w.name,phase:w.phase,recruitmentEndsAt:w.recruitmentEndsAt,players:humanCount(w),maxPlayers:HUMAN_MAX}});
});

app.post('/api/session/restore',(req,res)=>{const {playerId}=req.body||{};const p=db.players[playerId];if(!p)return res.status(404).json({error:'session not found'});payoutPlayer(p);p.lastSeen=now();const w=getWorld(p.worldId);ensurePhase(w);save(db);res.json({ok:true,player:playerPublic(p),world:w})});
app.post('/api/player/state',(req,res)=>{const {playerId,state}=req.body||{};const p=db.players[playerId];if(!p)return res.status(404).json({error:'session not found'});if(p.isAI)return res.status(403).json({error:'AI players are server-controlled'});payoutPlayer(p);for(const k of ['money','gems','soldiers','weapons','fighters','ships']){if(state?.[k]!==undefined){const n=Number(state[k]);if(!Number.isFinite(n)||n<0)return res.status(400).json({error:'invalid resource'});p[k]=Math.floor(n)}}p.lastSeen=now();save(db);res.json({ok:true,player:playerPublic(p)})});

app.get('/api/chat/:worldId',(req,res)=>{const w=getWorld(req.params.worldId);if(!w)return res.status(404).json({error:'world not found'});res.json({messages:w.chat.slice(-100)})});
app.post('/api/chat/:worldId',(req,res)=>{const w=getWorld(req.params.worldId);const {playerId,text}=req.body||{};const p=db.players[playerId];if(!w||!p||p.worldId!==w.id)return res.status(403).json({error:'wrong world'});const v=String(text||'').trim().slice(0,500);if(!v)return res.status(400).json({error:'empty message'});const msg={id:crypto.randomUUID(),playerId,country:p.country,text:v,at:iso()};w.chat.push(msg);w.chat=w.chat.slice(-500);p.lastSeen=now();save(db);res.json({ok:true,message:msg})});

app.use(express.static(PUBLIC));app.get('/{*splat}',(req,res)=>res.sendFile(path.join(PUBLIC,'index.html')));
setInterval(()=>{gameTick().catch(e=>console.error('game tick',e))},AI_TICK_MS);

gameTick().catch(e=>console.error('initial game tick',e));

// === ADMIN + AI MANAGEMENT CENTER ===
function requireAdmin(req,res){
  const password=String(req.body?.password||req.query?.password||'');
  if(password!==ADMIN_PANEL_PASSWORD){
    res.status(401).json({ok:false,error:'invalid admin password'}); return false;
  }
  return true;
}
function requireAI(req,res){
  const password=String(req.body?.password||req.query?.password||'');
  if(password!==AI_GROUP_PASSWORD){
    res.status(401).json({ok:false,error:'invalid AI-group password'}); return false;
  }
  return true;
}

app.post('/api/admin/dashboard',(req,res)=>{
  if(!requireAdmin(req,res))return;
  res.json({
    ok:true,
    role:'admin',
    worlds:db.worlds.map(w=>({
      id:w.id,name:w.name,phase:w.phase,
      realPlayers:humanCount(w),aiPlayers:botCount(w),online:onlineCount(w),
      startedAt:w.startedAt||null,
      aiDirector:w.aiDirector?.status||'idle',
      aiTakeoverAt:w.aiTakeoverAt||null
    }))
  });
});

app.post('/api/admin/ai/enable',(req,res)=>{
  if(!requireAdmin(req,res))return;
  const w=getWorld(req.body?.worldId);
  if(!w)return res.status(404).json({ok:false,error:'world not found'});
  w.aiEnabled=req.body?.enabled!==false;
  res.json({ok:true,aiEnabled:w.aiEnabled});
});

app.post('/api/admin/ai/run',(req,res)=>{
  if(!requireAdmin(req,res))return;
  const w=getWorld(req.body?.worldId);
  if(!w)return res.status(404).json({ok:false,error:'world not found'});
  runAIBasic(w);
  res.json({ok:true,message:'AI cycle queued',bots:w.bots.length});
});

app.post('/api/admin/maintenance',(req,res)=>{
  if(!requireAdmin(req,res))return;
  const action=String(req.body?.action||'');
  const allowed=['status','clear-ai-alerts'];
  if(!allowed.includes(action))return res.status(400).json({ok:false,error:'unsupported maintenance action'});
  if(action==='clear-ai-alerts'){
    for(const w of db.worlds) if(w.aiDirector) w.aiDirector.alerts=[];
  }
  res.json({ok:true,action});
});

app.post('/api/ai-team/dashboard',(req,res)=>{
  if(!requireAI(req,res))return;
  res.json({
    ok:true,role:'ai-manager',
    capabilities:['analyze','diagnose','plan-update','test-flows','balance-review'],
    worlds:db.worlds.map(w=>({
      id:w.id,name:w.name,phase:w.phase,
      realPlayers:humanCount(w),aiPlayers:botCount(w),online:onlineCount(w),
      director:w.aiDirector?.status||'idle',
      report:w.aiDirector?.lastReport||null,
      alerts:w.aiDirector?.alerts||[]
    }))
  });
});

app.post('/api/ai-team/diagnose',(req,res)=>{
  if(!requireAI(req,res))return;
  const findings=[];
  for(const w of db.worlds){
    if(humanCount(w)===0 && w.phase==='active') findings.push({world:w.id,type:'population',severity:'medium',message:'سرور بازیکن واقعی ندارد'});
    if((w.aiDirector?.alerts||[]).length) findings.push(...w.aiDirector.alerts.map(a=>({...a,world:w.id})));
  }
  res.json({ok:true,findings});
});

app.post('/api/ai-team/update-plan',(req,res)=>{
  if(!requireAI(req,res))return;
  res.json({
    ok:true,
    requiresAdminApproval:true,
    plan:[
      'بررسی وضعیت بازیکنان واقعی و AI',
      'بررسی خطاهای بازی و سرور',
      'بررسی تعادل اقتصاد و بازار',
      'بررسی رفتار کشورهای AI',
      'اجرای تست‌های غیرمخرب',
      'ارسال پیشنهاد تغییرات برای تأیید مدیر'
    ]
  });
});

app.listen(PORT,'0.0.0.0',()=>console.log(`Donyaye No authoritative server: ${PORT} | AI ${MODEL} | worlds ${db.worlds.length}`));

// AI update coordinator: returns a safe plan for game updates; actual code/deploy
// changes remain under admin control and are never performed from the client APK.
app.post('/api/ai-team/update-plan',(req,res)=>{
  const password=String(req.body?.password||'');
  if(password!==AI_GROUP_PASSWORD)return res.status(401).json({ok:false,error:'invalid password'});
  res.json({
    ok:true,
    role:'ai-manager',
    capabilities:[
      'analyze_game_state',
      'detect_server_and_gameplay_errors',
      'suggest_balance_updates',
      'test_game_flows',
      'prepare_update_plan'
    ],
    requiresAdminApproval:true
  });
});
