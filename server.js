const express  = require('express');
const http     = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const fs       = require('fs-extra');
const path     = require('path');

const PORT        = process.env.PORT       || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'knb_secret_2025';
const OWNER_EMAIL = process.env.OWNER_EMAIL|| 'foxi@knb.com';
const OWNER_PASS  = process.env.OWNER_PASS || 'admin005';


const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH  = require('path').join(DATA_DIR, 'knb_db.json');
const DB_BACKUP = require('path').join(DATA_DIR, 'knb_db_backup.json');


const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── БД ───────────────────────────────────────────
let DB = { users:[], posts:[], commPosts:[], communities:[], commMembers:[], friendships:[], messages:[], groups:[], verReqs:[], bans:[], notifications:[] };

async function loadDB() {
  // Создать директорию если не существует
  await fs.ensureDir(DATA_DIR).catch(()=>{});
  await fs.ensureDir('/tmp').catch(()=>{});
  // Попробовать загрузить основную, потом резервную
  for (const p of [DB_PATH, DB_BACKUP]) {
    try {
      if (await fs.pathExists(p)) {
        const data = await fs.readJson(p);
        if (data.commMembers) data.commMembers = data.commMembers.map(m=>({...m,rank:m.rank||'member'}));
        DB = { ...DB, ...data };
        console.log('[DB] loaded from', p);
        return;
      }
    } catch(e) { console.error('[DB] error loading', p, e.message); }
  }
  await saveDB();
}

let _saveTimer = null;
async function saveDB() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      await fs.writeJson(DB_PATH, DB);
      await fs.writeJson(DB_BACKUP, DB); // резервная копия рядом с server.js
    } catch(e) { console.error('[DB] save error:', e.message); }
  }, 500);
}

// Немедленное сохранение при shutdown
process.on('SIGTERM', async () => { clearTimeout(_saveTimer); await fs.writeJson(DB_PATH, DB).catch(()=>{}); await fs.writeJson(DB_BACKUP, DB).catch(()=>{}); process.exit(0); });
process.on('SIGINT',  async () => { clearTimeout(_saveTimer); await fs.writeJson(DB_PATH, DB).catch(()=>{}); await fs.writeJson(DB_BACKUP, DB).catch(()=>{}); process.exit(0); });

// ── Хелперы ──────────────────────────────────────
const fu  = id => DB.users.find(u=>u.id===id);
const fc  = id => DB.communities.find(c=>c.id===id);
const isBanned = uid => DB.bans.some(b=>b.uid===uid);
const RANK_POST   = new Set(['owner','admin','moderator']);
const RANK_MANAGE = new Set(['owner','admin']);
function getMemberRank(cid, uid) {
  if (fc(cid)?.createdBy===uid) return 'owner';
  return DB.commMembers.find(x=>x.cid===cid&&x.uid===uid)?.rank||null;
}
function canPost(cid,uid)   { return fu(uid)?.email===OWNER_EMAIL||(getMemberRank(cid,uid)&&RANK_POST.has(getMemberRank(cid,uid))); }
function canManage(cid,uid) { return fu(uid)?.email===OWNER_EMAIL||(getMemberRank(cid,uid)&&RANK_MANAGE.has(getMemberRank(cid,uid))); }

// ── WS ───────────────────────────────────────────
const clients   = new Map(); // uid -> Set<ws>
const onlineSet = new Set(); // uid онлайн

function sendTo(uid, data) {
  const msg = JSON.stringify(data);
  clients.get(uid)?.forEach(ws=>{ if(ws.readyState===WebSocket.OPEN) ws.send(msg); });
}
function broadcast(data, exceptUid) {
  const msg = JSON.stringify(data);
  clients.forEach((set,uid)=>{ if(uid===exceptUid) return; set.forEach(ws=>{ if(ws.readyState===WebSocket.OPEN) ws.send(msg); }); });
}
function chatRecipients(chatId, exceptUid) {
  if (chatId.startsWith('g_'))  return (DB.groups.find(x=>x.id===chatId)?.members||[]).filter(id=>id!==exceptUid);
  if (chatId.startsWith('cc_')) return DB.commMembers.filter(m=>m.cid===chatId.replace('cc_','')).map(m=>m.uid).filter(id=>id!==exceptUid);
  return chatId.replace(/^chat_/,'').split('_').filter(id=>id!==exceptUid&&!!fu(id));
}
function pushNotif(uid, text) {
  const n={id:'n_'+uuid(),uid,text,read:false,ts:new Date().toISOString()};
  DB.notifications.push(n); saveDB();
  sendTo(uid,{type:'notification',text,ts:n.ts});
}

function auth(req,res,next){
  const t=(req.headers.authorization||'').split(' ')[1];
  if(!t) return res.status(401).json({error:'Нет токена'});
  try{req.user=jwt.verify(t,JWT_SECRET);next();}catch{res.status(401).json({error:'Токен недействителен'});}
}
function ownerOnly(req,res,next){
  if(fu(req.user.id)?.email!==OWNER_EMAIL) return res.status(403).json({error:'Только для владельца'});
  next();
}

wss.on('connection', ws => {
  ws.uid = null;
  ws.on('message', raw => {
    let m; try{m=JSON.parse(raw);}catch{return;}
    if (m.type==='auth') {
      try {
        const d=jwt.verify(m.token,JWT_SECRET);
        ws.uid=d.id;
        if(!clients.has(ws.uid)) clients.set(ws.uid,new Set());
        clients.get(ws.uid).add(ws);
        onlineSet.add(ws.uid);
        ws.send(JSON.stringify({type:'authed',userId:ws.uid}));
        // Отправить список онлайн новому клиенту
        ws.send(JSON.stringify({type:'online_list',users:[...onlineSet]}));
        // Уведомить всех что этот пользователь онлайн
        broadcast({type:'user_online',uid:ws.uid},ws.uid);
      } catch { ws.send(JSON.stringify({type:'auth_error'})); }
      return;
    }
    if(!ws.uid) return;
    if(m.type==='call_offer')  {const c=fu(ws.uid);sendTo(m.to,{type:'call_incoming',from:ws.uid,callerName:c?.name,callerAva:c?.avatar,offer:m.offer,callType:m.callType});}
    if(m.type==='call_answer') sendTo(m.to,{type:'call_answer',answer:m.answer,from:ws.uid});
    if(m.type==='call_ice')    sendTo(m.to,{type:'call_ice',candidate:m.candidate,from:ws.uid});
    if(m.type==='call_reject') sendTo(m.to,{type:'call_rejected',from:ws.uid});
    if(m.type==='call_end')    sendTo(m.to,{type:'call_ended',from:ws.uid});
    if(m.type==='typing')      chatRecipients(m.chatId,ws.uid).forEach(uid=>sendTo(uid,{type:'typing',chatId:m.chatId,name:fu(ws.uid)?.name}));
  });
  ws.on('close',()=>{
    if(ws.uid&&clients.has(ws.uid)){
      clients.get(ws.uid).delete(ws);
      if(!clients.get(ws.uid).size){
        clients.delete(ws.uid);
        onlineSet.delete(ws.uid);
        broadcast({type:'user_offline',uid:ws.uid},ws.uid);
      }
    }
  });
  ws.on('error',()=>{});
});

// ═══ ROUTES ═══════════════════════════════════════

app.post('/api/auth/register', async(req,res)=>{
  try{
    let{email,password,name,username,bio,avatar}=req.body;
    if(!email||!password||!name||!username) return res.status(400).json({error:'Заполните все поля'});
    email=email.trim().toLowerCase();
    if(DB.users.find(u=>u.email===email)) return res.status(400).json({error:'Email уже занят'});
    const uname=username.trim().startsWith('@')?username.trim():'@'+username.trim();
    if(DB.users.find(u=>u.username===uname)) return res.status(400).json({error:'Username занят'});
    const hash=await bcrypt.hash(password,10);
    const user={id:'u_'+uuid(),email,password:hash,name:name.trim(),username:uname,bio:bio||'',avatar:avatar||'',banner:'',verified:false,friends:[],createdAt:new Date().toISOString()};
    DB.users.push(user);saveDB();
    const token=jwt.sign({id:user.id},JWT_SECRET,{expiresIn:'30d'});
    const{password:_,...safe}=user;res.json({token,user:safe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/auth/login', async(req,res)=>{
  try{
    let{id:loginId,password}=req.body;
    if(!loginId||!password) return res.status(400).json({error:'Заполните все поля'});
    loginId=loginId.trim();
    const user=DB.users.find(u=>u.email===loginId.toLowerCase())||DB.users.find(u=>u.username===(loginId.startsWith('@')?loginId:'@'+loginId));
    if(!user)                                      return res.status(401).json({error:'Пользователь не найден'});
    if(!(await bcrypt.compare(password,user.password))) return res.status(401).json({error:'Неверный пароль'});
    if(isBanned(user.id))                          return res.status(403).json({error:'Аккаунт заблокирован'});
    const token=jwt.sign({id:user.id},JWT_SECRET,{expiresIn:'30d'});
    const{password:_,...safe}=user;res.json({token,user:safe});
  }catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/users',auth,(_,res)=>res.json(DB.users.map(({password,...u})=>u)));

app.put('/api/users/:id',auth,async(req,res)=>{
  if(req.user.id!==req.params.id) return res.status(403).json({error:'Forbidden'});
  const user=fu(req.params.id);if(!user) return res.status(404).json({error:'Not found'});
  const{name,username,bio,avatar,banner,password}=req.body;
  if(name) user.name=name.trim();
  if(bio!==undefined) user.bio=bio;
  if(avatar) user.avatar=avatar;
  if(banner) user.banner=banner;
  if(username){const uname=username.trim().startsWith('@')?username.trim():'@'+username.trim();if(DB.users.some(u=>u.username===uname&&u.id!==user.id))return res.status(400).json({error:'Username занят'});user.username=uname;}
  if(password) user.password=await bcrypt.hash(password,10);
  saveDB();const{password:_,...safe}=user;res.json(safe);
});

app.get('/api/posts',auth,(_,res)=>res.json([...DB.posts,...DB.commPosts].sort((a,b)=>new Date(b.ts)-new Date(a.ts))));

app.post('/api/posts',auth,async(req,res)=>{
  const{text,media,communityId}=req.body;
  if(!text&&!media) return res.status(400).json({error:'Пустой пост'});
  if(communityId&&!canPost(communityId,req.user.id)) return res.status(403).json({error:'Нет прав публиковать'});
  const post={id:'p_'+uuid(),authorId:req.user.id,text:text||'',media:media||null,likes:[],comments:[],ts:new Date().toISOString()};
  if(communityId){post.communityId=communityId;DB.commPosts.push(post);}else DB.posts.push(post);
  saveDB();broadcast({type:'new_post',post},req.user.id);res.json(post);
});

app.post('/api/posts/:id/like',auth,async(req,res)=>{
  const post=[...DB.posts,...DB.commPosts].find(p=>p.id===req.params.id);
  if(!post) return res.status(404).json({error:'Not found'});
  if(!post.likes) post.likes=[];
  const idx=post.likes.indexOf(req.user.id);
  if(idx>=0) post.likes.splice(idx,1);
  else{post.likes.push(req.user.id);if(post.authorId!==req.user.id)pushNotif(post.authorId,`❤️ ${fu(req.user.id)?.name||'?'} лайкнул ваш пост`);}
  saveDB();res.json(post);
});

app.post('/api/posts/:id/comment',auth,async(req,res)=>{
  const post=[...DB.posts,...DB.commPosts].find(p=>p.id===req.params.id);
  if(!post) return res.status(404).json({error:'Not found'});
  if(!req.body.text?.trim()) return res.status(400).json({error:'Пустой комментарий'});
  if(!post.comments) post.comments=[];
  const cmt={id:'c_'+uuid(),uid:req.user.id,text:req.body.text.trim(),ts:new Date().toISOString()};
  post.comments.push(cmt);
  if(post.authorId!==req.user.id) pushNotif(post.authorId,`💬 ${fu(req.user.id)?.name||'?'} прокомментировал ваш пост`);
  saveDB();res.json(post);
});

// Удаление комментария
app.delete('/api/posts/:pid/comment/:cid',auth,async(req,res)=>{
  const post=[...DB.posts,...DB.commPosts].find(p=>p.id===req.params.pid);
  if(!post) return res.status(404).json({error:'Not found'});
  const isAdmin=fu(req.user.id)?.email===OWNER_EMAIL;
  const idx=(post.comments||[]).findIndex(c=>c.id===req.params.cid&&(c.uid===req.user.id||isAdmin||post.authorId===req.user.id));
  if(idx<0) return res.status(403).json({error:'Forbidden'});
  post.comments.splice(idx,1);saveDB();res.json(post);
});

app.delete('/api/posts/:id',auth,async(req,res)=>{
  const isAdmin=fu(req.user.id)?.email===OWNER_EMAIL;
  const pi=DB.posts.findIndex(p=>p.id===req.params.id&&(p.authorId===req.user.id||isAdmin));
  const ci=DB.commPosts.findIndex(p=>p.id===req.params.id&&(p.authorId===req.user.id||isAdmin));
  if(pi>=0) DB.posts.splice(pi,1);else if(ci>=0) DB.commPosts.splice(ci,1);else return res.status(403).json({error:'Forbidden'});
  saveDB();res.json({ok:true});
});

app.get('/api/friendships',auth,(req,res)=>res.json(DB.friendships.filter(f=>f.from===req.user.id||f.to===req.user.id)));

app.post('/api/friendships',auth,async(req,res)=>{
  const{to}=req.body;if(!to||to===req.user.id)return res.status(400).json({error:'Неверный запрос'});
  if(DB.friendships.find(f=>f.from===req.user.id&&f.to===to))return res.status(400).json({error:'Заявка уже отправлена'});
  const f={id:'f_'+uuid(),from:req.user.id,to,status:'pending',ts:new Date().toISOString()};
  DB.friendships.push(f);const sender=fu(req.user.id);
  pushNotif(to,`👤 ${sender?.name||'?'} хочет добавить вас в друзья`);
  sendTo(to,{type:'friend_request',friendship:f,senderName:sender?.name});
  saveDB();res.json(f);
});

app.put('/api/friendships/:id/accept',auth,async(req,res)=>{
  const f=DB.friendships.find(x=>x.id===req.params.id&&x.to===req.user.id);
  if(!f) return res.status(404).json({error:'Not found'});
  f.status='accepted';
  const from=fu(f.from),to=fu(f.to);
  if(from){if(!from.friends)from.friends=[];if(!from.friends.includes(f.to))from.friends.push(f.to);}
  if(to){if(!to.friends)to.friends=[];if(!to.friends.includes(f.from))to.friends.push(f.from);}
  pushNotif(f.from,`✅ ${to?.name||'?'} принял вашу заявку в друзья`);
  sendTo(f.from,{type:'friend_accepted',byName:to?.name});saveDB();res.json(f);
});

app.delete('/api/friendships/:id',auth,async(req,res)=>{
  const idx=DB.friendships.findIndex(f=>f.id===req.params.id&&(f.from===req.user.id||f.to===req.user.id));
  if(idx<0)return res.status(404).json({error:'Not found'});
  const f=DB.friendships.splice(idx,1)[0];
  const u1=fu(f.from),u2=fu(f.to);
  if(u1)u1.friends=(u1.friends||[]).filter(id=>id!==f.to);
  if(u2)u2.friends=(u2.friends||[]).filter(id=>id!==f.from);
  saveDB();res.json({ok:true});
});

app.get('/api/messages',auth,(req,res)=>{
  const{chatId}=req.query;if(!chatId)return res.status(400).json({error:'chatId required'});
  res.json(DB.messages.filter(m=>m.chatId===chatId).sort((a,b)=>new Date(a.ts)-new Date(b.ts)));
});

app.post('/api/messages',auth,async(req,res)=>{
  const{chatId,text,img,voice}=req.body;
  if(!chatId)return res.status(400).json({error:'chatId required'});
  if(!text&&!img&&!voice)return res.status(400).json({error:'Пустое сообщение'});
  if(chatId.startsWith('cc_')&&!canPost(chatId.replace('cc_',''),req.user.id))return res.status(403).json({error:'Нет прав'});
  const msg={id:'m_'+uuid(),chatId,senderId:req.user.id,text:text||null,img:img||null,voice:voice||null,ts:new Date().toISOString()};
  DB.messages.push(msg);saveDB();
  const recips=chatRecipients(chatId,req.user.id);
  recips.forEach(uid=>sendTo(uid,{type:'new_message',message:msg}));
  if(!chatId.startsWith('g_')&&!chatId.startsWith('cc_')){
    const sender=fu(req.user.id);
    recips.forEach(uid=>pushNotif(uid,`💌 ${sender?.name||'?'} написал вам сообщение`));
  }
  res.json(msg);
});

app.delete('/api/messages/:id',auth,async(req,res)=>{
  const idx=DB.messages.findIndex(m=>m.id===req.params.id&&m.senderId===req.user.id);
  if(idx>=0){DB.messages.splice(idx,1);saveDB();return res.json({ok:true});}
  const msg=DB.messages.find(m=>m.id===req.params.id);
  if(!msg)return res.status(404).json({error:'Not found'});
  const ok=fu(req.user.id)?.email===OWNER_EMAIL||(msg.chatId.startsWith('cc_')&&canManage(msg.chatId.replace('cc_',''),req.user.id));
  if(!ok)return res.status(403).json({error:'Forbidden'});
  DB.messages.splice(DB.messages.indexOf(msg),1);saveDB();res.json({ok:true});
});

app.get('/api/communities',auth,(_,res)=>res.json(DB.communities));

app.post('/api/communities',auth,async(req,res)=>{
  const{name,description,avatar}=req.body;
  if(!name?.trim())return res.status(400).json({error:'Название обязательно'});
  const comm={id:'c_'+uuid(),name:name.trim(),description:description||'',avatar:avatar||'',banner:'',verified:false,createdBy:req.user.id,ts:new Date().toISOString()};
  DB.communities.push(comm);DB.commMembers.push({uid:req.user.id,cid:comm.id,rank:'owner',ts:new Date().toISOString()});saveDB();res.json(comm);
});

app.get('/api/communities/:id/members',auth,(req,res)=>{
  const cid=req.params.id,comm=fc(cid);
  res.json(DB.commMembers.filter(m=>m.cid===cid).map(m=>({uid:m.uid,rank:comm?.createdBy===m.uid?'owner':(m.rank||'member'),ts:m.ts})));
});

app.post('/api/communities/:id/join',auth,async(req,res)=>{
  const cid=req.params.id;if(!fc(cid))return res.status(404).json({error:'Not found'});
  if(!DB.commMembers.find(m=>m.cid===cid&&m.uid===req.user.id))DB.commMembers.push({uid:req.user.id,cid,rank:'member',ts:new Date().toISOString()});
  saveDB();res.json({ok:true});
});

app.post('/api/communities/:id/leave',auth,async(req,res)=>{
  const cid=req.params.id;
  if(fc(cid)?.createdBy===req.user.id)return res.status(400).json({error:'Создатель не может покинуть'});
  DB.commMembers=DB.commMembers.filter(m=>!(m.cid===cid&&m.uid===req.user.id));saveDB();res.json({ok:true});
});

app.post('/api/communities/:id/rank',auth,async(req,res)=>{
  const cid=req.params.id;const{userId,rank}=req.body;
  if(!['admin','moderator','member'].includes(rank))return res.status(400).json({error:'Неверный ранг'});
  if(!canManage(cid,req.user.id))return res.status(403).json({error:'Нет прав'});
  const comm=fc(cid);if(!comm)return res.status(404).json({error:'Not found'});
  if(comm.createdBy===userId)return res.status(400).json({error:'Нельзя изменить ранг создателя'});
  const m=DB.commMembers.find(x=>x.cid===cid&&x.uid===userId);
  if(!m)return res.status(404).json({error:'Участник не найден'});
  m.rank=rank;saveDB();
  const names={admin:'Админ',moderator:'Модератор',member:'Участник'};
  pushNotif(userId,`⚡ ${fu(req.user.id)?.name||'?'} назначил вам ранг "${names[rank]}" в "${comm.name}"`);
  res.json({ok:true});
});

app.get('/api/groups',auth,(req,res)=>res.json(DB.groups.filter(g=>(g.members||[]).includes(req.user.id))));
app.post('/api/groups',auth,async(req,res)=>{
  const{name}=req.body;if(!name?.trim())return res.status(400).json({error:'Название обязательно'});
  const g={id:'g_'+uuid(),name:name.trim(),members:[req.user.id],createdBy:req.user.id,ts:new Date().toISOString()};
  DB.groups.push(g);saveDB();res.json(g);
});
app.post('/api/groups/:id/add',auth,async(req,res)=>{
  const g=DB.groups.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'Not found'});
  if(g.createdBy!==req.user.id)return res.status(403).json({error:'Только создатель'});
  if(!g.members.includes(req.body.userId))g.members.push(req.body.userId);saveDB();res.json(g);
});

app.get('/api/notifications',auth,(req,res)=>res.json(DB.notifications.filter(n=>n.uid===req.user.id).sort((a,b)=>new Date(b.ts)-new Date(a.ts))));
app.post('/api/notifications/read',auth,async(req,res)=>{DB.notifications.filter(n=>n.uid===req.user.id).forEach(n=>n.read=true);saveDB();res.json({ok:true});});

app.post('/api/verify-request',auth,async(req,res)=>{
  if(DB.verReqs.find(r=>r.uid===req.user.id&&r.status==='pending'))return res.status(400).json({error:'Заявка уже отправлена'});
  DB.verReqs.push({id:'vr_'+uuid(),uid:req.user.id,status:'pending',ts:new Date().toISOString()});saveDB();res.json({ok:true});
});

// Рассылка от создателя
app.post('/api/admin/broadcast',auth,ownerOnly,async(req,res)=>{
  const{text}=req.body;if(!text?.trim())return res.status(400).json({error:'Пустой текст'});
  const sender=fu(req.user.id);
  DB.users.forEach(u=>{
    if(u.id===req.user.id)return;
    // Сохранить как сообщение в личку
    const chatId='chat_'+[req.user.id,u.id].sort().join('_');
    const msg={id:'m_'+uuid(),chatId,senderId:req.user.id,text:text.trim(),img:null,voice:null,ts:new Date().toISOString()};
    DB.messages.push(msg);
    sendTo(u.id,{type:'new_message',message:msg});
    pushNotif(u.id,`📢 ${sender?.name||'Администратор'}: ${text.trim().substring(0,60)}`);
  });
  saveDB();res.json({ok:true,sent:DB.users.length-1});
});

// Статистика
app.get('/api/admin/stats',auth,ownerOnly,(_,res)=>res.json({
  users:DB.users.length,posts:DB.posts.length+DB.commPosts.length,communities:DB.communities.length,
  messages:DB.messages.length,pendingVerify:DB.verReqs.filter(r=>r.status==='pending').length,
  banned:DB.bans.length,verified:DB.users.filter(u=>u.verified).length,online:onlineSet.size
}));

app.get('/api/admin/verReqs',auth,ownerOnly,(_,res)=>res.json(DB.verReqs));

app.post('/api/admin/verReqs/:id/approve',auth,ownerOnly,async(req,res)=>{
  const r=DB.verReqs.find(x=>x.id===req.params.id);if(!r)return res.status(404).json({error:'Not found'});
  r.status='approved';const u=fu(r.uid);
  if(u){u.verified=true;pushNotif(u.id,'🎉 Ваш аккаунт верифицирован!');sendTo(u.id,{type:'verified'});}saveDB();res.json({ok:true});
});
app.post('/api/admin/verReqs/:id/reject',auth,ownerOnly,async(req,res)=>{
  const idx=DB.verReqs.findIndex(x=>x.id===req.params.id);if(idx<0)return res.status(404).json({error:'Not found'});
  const r=DB.verReqs.splice(idx,1)[0];pushNotif(r.uid,'❌ Заявка на верификацию отклонена');saveDB();res.json({ok:true});
});
app.post('/api/admin/users/:id/ban',auth,ownerOnly,async(req,res)=>{
  const uid=req.params.id;if(fu(uid)?.email===OWNER_EMAIL)return res.status(400).json({error:'Нельзя'});
  if(!DB.bans.find(b=>b.uid===uid))DB.bans.push({uid,ts:new Date().toISOString()});
  pushNotif(uid,'🚫 Ваш аккаунт заблокирован');sendTo(uid,{type:'banned'});saveDB();res.json({ok:true});
});
app.post('/api/admin/users/:id/unban',auth,ownerOnly,async(req,res)=>{
  DB.bans=DB.bans.filter(b=>b.uid!==req.params.id);pushNotif(req.params.id,'✅ Вы разблокированы');saveDB();res.json({ok:true});
});
app.post('/api/admin/users/:id/verify',auth,ownerOnly,async(req,res)=>{
  const u=fu(req.params.id);if(!u)return res.status(404).json({error:'Not found'});
  u.verified=!u.verified;if(u.verified){pushNotif(u.id,'🎉 Вы верифицированы!');sendTo(u.id,{type:'verified'});}saveDB();res.json({ok:true});
});
app.delete('/api/admin/users/:id',auth,ownerOnly,async(req,res)=>{
  const uid=req.params.id;if(fu(uid)?.email===OWNER_EMAIL)return res.status(400).json({error:'Нельзя'});
  DB.users=DB.users.filter(u=>u.id!==uid);DB.posts=DB.posts.filter(p=>p.authorId!==uid);
  DB.commPosts=DB.commPosts.filter(p=>p.authorId!==uid);DB.messages=DB.messages.filter(m=>m.senderId!==uid);
  DB.friendships=DB.friendships.filter(f=>f.from!==uid&&f.to!==uid);DB.commMembers=DB.commMembers.filter(m=>m.uid!==uid);
  DB.bans=DB.bans.filter(b=>b.uid!==uid);DB.users.forEach(u=>{u.friends=(u.friends||[]).filter(id=>id!==uid);});saveDB();res.json({ok:true});
});
app.delete('/api/admin/posts/:id',auth,ownerOnly,async(req,res)=>{
  DB.posts=DB.posts.filter(p=>p.id!==req.params.id);DB.commPosts=DB.commPosts.filter(p=>p.id!==req.params.id);saveDB();res.json({ok:true});
});
app.post('/api/admin/communities/:id/verify',auth,ownerOnly,async(req,res)=>{
  const c=fc(req.params.id);if(!c)return res.status(404).json({error:'Not found'});c.verified=!c.verified;saveDB();res.json({ok:true});
});
app.delete('/api/admin/communities/:id',auth,ownerOnly,async(req,res)=>{
  const cid=req.params.id;
  DB.communities=DB.communities.filter(c=>c.id!==cid);DB.commMembers=DB.commMembers.filter(m=>m.cid!==cid);
  DB.commPosts=DB.commPosts.filter(p=>p.communityId!==cid);saveDB();res.json({ok:true});
});

app.get('/api/health',(_,res)=>res.json({ok:true,ts:new Date().toISOString(),online:onlineSet.size,users:DB.users.length}));

async function main(){
  await loadDB();
  if(!DB.users.find(u=>u.email===OWNER_EMAIL)){
    const hash=await bcrypt.hash(OWNER_PASS,10);
    DB.users.push({id:'user_owner',email:OWNER_EMAIL,password:hash,name:'Foxi005305',username:'@foxi',bio:'👑 Владелец KNB',avatar:'',banner:'',verified:true,friends:[],createdAt:new Date().toISOString()});
    DB.posts.push({id:'p_welcome',authorId:'user_owner',text:'👋 Добро пожаловать в KNB!',media:null,likes:[],comments:[],ts:new Date().toISOString()});
    await fs.writeJson(DB_PATH,DB).catch(()=>{});await fs.writeJson(DB_BACKUP,DB).catch(()=>{});
    console.log('[KNB] Owner created');
  }
  server.listen(PORT,'0.0.0.0',()=>console.log(`[KNB] Port ${PORT}`));
}
main().catch(console.error);
