const express=require('express'),http=require('http'),{WebSocketServer,WebSocket}=require('ws'),cors=require('cors'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),{v4:uuid}=require('uuid'),path=require('path'),fs=require('fs');
const PORT=process.env.PORT||3000,JWT_SECRET=process.env.JWT_SECRET||'knb2026',OWNER_EMAIL=process.env.OWNER_EMAIL||'foxi@knb.com',OWNER_PASS=process.env.OWNER_PASS||'admin005';
const DATA_DIR=process.env.DATA_DIR||'/data';try{fs.mkdirSync(DATA_DIR,{recursive:true});}catch{}
const DB_FILE=path.join(DATA_DIR,'knb.db');
let DB;try{const S=require('better-sqlite3');DB=new S(DB_FILE);DB.pragma('journal_mode=WAL');DB.pragma('foreign_keys=ON');console.log('[DB]',DB_FILE);}catch(e){console.error('[DB]',e.message);process.exit(1);}

DB.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,name TEXT NOT NULL,username TEXT UNIQUE NOT NULL,bio TEXT DEFAULT '',avatar TEXT DEFAULT '',banner TEXT DEFAULT '',verified INTEGER DEFAULT 0,siteRole TEXT DEFAULT 'user',createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,authorId TEXT NOT NULL,text TEXT DEFAULT '',mediaUrl TEXT,mediaType TEXT,communityId TEXT,ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS post_likes(postId TEXT,userId TEXT,PRIMARY KEY(postId,userId));
CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY,postId TEXT NOT NULL,uid TEXT NOT NULL,text TEXT NOT NULL,ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS communities(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT DEFAULT '',avatar TEXT DEFAULT '',banner TEXT DEFAULT '',verified INTEGER DEFAULT 0,createdBy TEXT NOT NULL,ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comm_members(cid TEXT,uid TEXT,rank TEXT DEFAULT 'member',ts TEXT,PRIMARY KEY(cid,uid));
CREATE TABLE IF NOT EXISTS friendships(id TEXT PRIMARY KEY,fromId TEXT,toId TEXT,status TEXT DEFAULT 'pending',ts TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chatId TEXT NOT NULL,senderId TEXT NOT NULL,text TEXT,img TEXT,voice TEXT,ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg ON messages(chatId);
CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,createdBy TEXT NOT NULL,ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS group_members(groupId TEXT,userId TEXT,PRIMARY KEY(groupId,userId));
CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,uid TEXT NOT NULL,text TEXT NOT NULL,read INTEGER DEFAULT 0,ts TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notif ON notifications(uid);
CREATE TABLE IF NOT EXISTS ver_requests(id TEXT PRIMARY KEY,uid TEXT,status TEXT DEFAULT 'pending',ts TEXT);
CREATE TABLE IF NOT EXISTS bans(id TEXT PRIMARY KEY,uid TEXT,reason TEXT DEFAULT '',bannedBy TEXT,expiresAt TEXT,ts TEXT);
CREATE TABLE IF NOT EXISTS mutes(id TEXT PRIMARY KEY,uid TEXT,reason TEXT DEFAULT '',mutedBy TEXT,expiresAt TEXT,ts TEXT);
CREATE TABLE IF NOT EXISTS stories(id TEXT PRIMARY KEY,authorId TEXT NOT NULL,mediaUrl TEXT NOT NULL,mediaType TEXT DEFAULT 'image',text TEXT DEFAULT '',ts TEXT NOT NULL,expiresAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS story_views(storyId TEXT,userId TEXT,ts TEXT,PRIMARY KEY(storyId,userId));
CREATE TABLE IF NOT EXISTS story_likes(storyId TEXT,userId TEXT,PRIMARY KEY(storyId,userId));
CREATE TABLE IF NOT EXISTS subscriptions(followerId TEXT,followingId TEXT,ts TEXT,PRIMARY KEY(followerId,followingId));
CREATE TABLE IF NOT EXISTS forum_posts(id TEXT PRIMARY KEY,authorId TEXT,title TEXT,text TEXT,category TEXT DEFAULT 'general',img TEXT,status TEXT DEFAULT 'open',pinned INTEGER DEFAULT 0,ts TEXT);
CREATE TABLE IF NOT EXISTS forum_replies(id TEXT PRIMARY KEY,postId TEXT,authorId TEXT,text TEXT,img TEXT,ts TEXT);
CREATE INDEX IF NOT EXISTS idx_fr ON forum_replies(postId);
CREATE TABLE IF NOT EXISTS complaints(id TEXT PRIMARY KEY,authorId TEXT,text TEXT,img TEXT,type TEXT DEFAULT 'other',targetId TEXT,status TEXT DEFAULT 'pending',ts TEXT);
CREATE TABLE IF NOT EXISTS complaint_replies(id TEXT PRIMARY KEY,complaintId TEXT,authorId TEXT,text TEXT,ts TEXT);
`);

const q={
  uById:DB.prepare('SELECT * FROM users WHERE id=?'),
  uByEmail:DB.prepare('SELECT * FROM users WHERE email=?'),
  uByUname:DB.prepare('SELECT * FROM users WHERE username=?'),
  allUsers:DB.prepare('SELECT * FROM users ORDER BY createdAt DESC'),
  insUser:DB.prepare('INSERT INTO users VALUES(@id,@email,@password,@name,@username,@bio,@avatar,@banner,0,"user",@createdAt)'),
  updUser:DB.prepare('UPDATE users SET name=@name,username=@username,bio=@bio,avatar=@avatar,banner=@banner WHERE id=@id'),
  updPass:DB.prepare('UPDATE users SET password=@password WHERE id=@id'),
  setVer:DB.prepare('UPDATE users SET verified=@v WHERE id=@id'),
  setRole:DB.prepare('UPDATE users SET siteRole=@role WHERE id=@id'),
  delUser:DB.prepare('DELETE FROM users WHERE id=?'),
  activeBan:DB.prepare("SELECT * FROM bans WHERE uid=? AND(expiresAt IS NULL OR expiresAt>datetime('now'))"),
  insBan:DB.prepare('INSERT INTO bans VALUES(@id,@uid,@reason,@bannedBy,@expiresAt,@ts)'),
  delBan:DB.prepare('DELETE FROM bans WHERE uid=?'),
  activeMute:DB.prepare("SELECT * FROM mutes WHERE uid=? AND(expiresAt IS NULL OR expiresAt>datetime('now'))"),
  insMute:DB.prepare('INSERT INTO mutes VALUES(@id,@uid,@reason,@mutedBy,@expiresAt,@ts)'),
  delMute:DB.prepare('DELETE FROM mutes WHERE uid=?'),
  allPosts:DB.prepare('SELECT * FROM posts ORDER BY ts DESC'),
  postById:DB.prepare('SELECT * FROM posts WHERE id=?'),
  insPost:DB.prepare('INSERT INTO posts VALUES(@id,@authorId,@text,@mediaUrl,@mediaType,@communityId,@ts)'),
  delPost:DB.prepare('DELETE FROM posts WHERE id=?'),
  likes:DB.prepare('SELECT userId FROM post_likes WHERE postId=?'),
  addLike:DB.prepare('INSERT OR IGNORE INTO post_likes VALUES(?,?)'),
  delLike:DB.prepare('DELETE FROM post_likes WHERE postId=? AND userId=?'),
  cmtsByPost:DB.prepare('SELECT * FROM comments WHERE postId=? ORDER BY ts ASC'),
  insCmt:DB.prepare('INSERT INTO comments VALUES(@id,@postId,@uid,@text,@ts)'),
  delCmt:DB.prepare('DELETE FROM comments WHERE id=?'),
  cmtById:DB.prepare('SELECT * FROM comments WHERE id=?'),
  allComms:DB.prepare('SELECT * FROM communities ORDER BY ts DESC'),
  commById:DB.prepare('SELECT * FROM communities WHERE id=?'),
  insComm:DB.prepare('INSERT INTO communities VALUES(@id,@name,@description,@avatar,@banner,0,@createdBy,@ts)'),
  delComm:DB.prepare('DELETE FROM communities WHERE id=?'),
  setCommVer:DB.prepare('UPDATE communities SET verified=@v WHERE id=@id'),
  commMembers:DB.prepare('SELECT * FROM comm_members WHERE cid=?'),
  memberRank:DB.prepare('SELECT rank FROM comm_members WHERE cid=? AND uid=?'),
  insMember:DB.prepare('INSERT OR IGNORE INTO comm_members VALUES(?,?,"member",?)'),
  delMember:DB.prepare('DELETE FROM comm_members WHERE cid=? AND uid=?'),
  updRank:DB.prepare('UPDATE comm_members SET rank=? WHERE cid=? AND uid=?'),
  friendsOf:DB.prepare('SELECT * FROM friendships WHERE fromId=? OR toId=?'),
  friendById:DB.prepare('SELECT * FROM friendships WHERE id=?'),
  insFriend:DB.prepare('INSERT INTO friendships VALUES(@id,@fromId,@toId,"pending",@ts)'),
  acceptF:DB.prepare("UPDATE friendships SET status='accepted' WHERE id=?"),
  delFriend:DB.prepare('DELETE FROM friendships WHERE id=?'),
  msgByChat:DB.prepare('SELECT * FROM messages WHERE chatId=? ORDER BY ts ASC'),
  insMsg:DB.prepare('INSERT INTO messages VALUES(@id,@chatId,@senderId,@text,@img,@voice,@ts)'),
  delMsg:DB.prepare('DELETE FROM messages WHERE id=?'),
  msgById:DB.prepare('SELECT * FROM messages WHERE id=?'),
  groupsForUser:DB.prepare('SELECT g.* FROM groups g INNER JOIN group_members gm ON g.id=gm.groupId WHERE gm.userId=?'),
  groupById:DB.prepare('SELECT * FROM groups WHERE id=?'),
  insGroup:DB.prepare('INSERT INTO groups VALUES(@id,@name,@createdBy,@ts)'),
  groupMembers:DB.prepare('SELECT userId FROM group_members WHERE groupId=?'),
  addGM:DB.prepare('INSERT OR IGNORE INTO group_members VALUES(?,?)'),
  notifs:DB.prepare('SELECT * FROM notifications WHERE uid=? ORDER BY ts DESC LIMIT 60'),
  insNotif:DB.prepare('INSERT INTO notifications VALUES(@id,@uid,@text,0,@ts)'),
  readNotifs:DB.prepare('UPDATE notifications SET read=1 WHERE uid=?'),
  pendingVR:DB.prepare("SELECT * FROM ver_requests WHERE status='pending'"),
  vrByUser:DB.prepare("SELECT * FROM ver_requests WHERE uid=? AND status='pending'"),
  insVR:DB.prepare('INSERT INTO ver_requests VALUES(@id,@uid,"pending",@ts)'),
  approveVR:DB.prepare("UPDATE ver_requests SET status='approved' WHERE id=?"),
  delVR:DB.prepare('DELETE FROM ver_requests WHERE id=?'),
  activeStories:DB.prepare("SELECT * FROM stories WHERE expiresAt>datetime('now') ORDER BY ts DESC"),
  insStory:DB.prepare('INSERT INTO stories VALUES(@id,@authorId,@mediaUrl,@mediaType,@text,@ts,@expiresAt)'),
  delStory:DB.prepare('DELETE FROM stories WHERE id=?'),
  storyById:DB.prepare('SELECT * FROM stories WHERE id=?'),
  viewStory:DB.prepare('INSERT OR IGNORE INTO story_views VALUES(?,?,?)'),
  storyViews:DB.prepare('SELECT sv.userId,u.name,u.avatar FROM story_views sv LEFT JOIN users u ON u.id=sv.userId WHERE sv.storyId=?'),
  likeStory:DB.prepare('INSERT OR IGNORE INTO story_likes VALUES(?,?)'),
  unlikeStory:DB.prepare('DELETE FROM story_likes WHERE storyId=? AND userId=?'),
  storyLikes:DB.prepare('SELECT userId FROM story_likes WHERE storyId=?'),
  sub:DB.prepare('INSERT OR IGNORE INTO subscriptions VALUES(?,?,?)'),
  unsub:DB.prepare('DELETE FROM subscriptions WHERE followerId=? AND followingId=?'),
  followers:DB.prepare('SELECT followerId FROM subscriptions WHERE followingId=?'),
  following:DB.prepare('SELECT followingId FROM subscriptions WHERE followerId=?'),
  isFollowing:DB.prepare('SELECT 1 FROM subscriptions WHERE followerId=? AND followingId=?'),
  allForum:DB.prepare('SELECT * FROM forum_posts ORDER BY pinned DESC,ts DESC'),
  forumById:DB.prepare('SELECT * FROM forum_posts WHERE id=?'),
  insForum:DB.prepare('INSERT INTO forum_posts VALUES(@id,@authorId,@title,@text,@category,@img,"open",0,@ts)'),
  delForum:DB.prepare('DELETE FROM forum_posts WHERE id=?'),
  forumStatus:DB.prepare('UPDATE forum_posts SET status=? WHERE id=?'),
  forumPin:DB.prepare('UPDATE forum_posts SET pinned=? WHERE id=?'),
  forumReplies:DB.prepare('SELECT * FROM forum_replies WHERE postId=? ORDER BY ts ASC'),
  insForumReply:DB.prepare('INSERT INTO forum_replies VALUES(@id,@postId,@authorId,@text,@img,@ts)'),
  delForumReply:DB.prepare('DELETE FROM forum_replies WHERE id=?'),
  forumReplyById:DB.prepare('SELECT * FROM forum_replies WHERE id=?'),
  allComplaints:DB.prepare('SELECT * FROM complaints ORDER BY ts DESC'),
  myComplaints:DB.prepare('SELECT * FROM complaints WHERE authorId=? ORDER BY ts DESC'),
  complaintById:DB.prepare('SELECT * FROM complaints WHERE id=?'),
  insComplaint:DB.prepare('INSERT INTO complaints VALUES(@id,@authorId,@text,@img,@type,@targetId,"pending",@ts)'),
  delComplaint:DB.prepare('DELETE FROM complaints WHERE id=?'),
  complaintStatus:DB.prepare('UPDATE complaints SET status=? WHERE id=?'),
  compReplies:DB.prepare('SELECT * FROM complaint_replies WHERE complaintId=? ORDER BY ts ASC'),
  insCompReply:DB.prepare('INSERT INTO complaint_replies VALUES(@id,@complaintId,@authorId,@text,@ts)'),
};

const now=()=>new Date().toISOString(),uid=uuid;
function safe(u){if(!u)return null;const{password,...s}=u;s.verified=!!s.verified;return s;}
function ePost(p){return{...p,likes:q.likes.all(p.id).map(r=>r.userId),comments:q.cmtsByPost.all(p.id),media:p.mediaUrl?{url:p.mediaUrl,t:p.mediaType}:null};}
function eForum(p){return{...p,pinned:!!p.pinned,author:safe(q.uById.get(p.authorId)),replies:q.forumReplies.all(p.id).map(r=>({...r,author:safe(q.uById.get(r.authorId))}))};}
const isBanned=uid=>!!q.activeBan.get(uid);
const isMuted=uid=>!!q.activeMute.get(uid);
function isOwnerU(uid){const u=q.uById.get(uid);return u&&u.email===OWNER_EMAIL;}
function isStaff(uid){const u=q.uById.get(uid);if(!u)return false;if(u.email===OWNER_EMAIL)return true;return['admin','moderator','helper'].includes(u.siteRole);}
function canManage(uid){const u=q.uById.get(uid);if(!u)return false;if(u.email===OWNER_EMAIL)return true;return u.siteRole==='admin';}

const app=express(),server=http.createServer(app),wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,sock,head)=>wss.handleUpgrade(req,sock,head,ws=>wss.emit('connection',ws,req)));
app.use(cors({origin:'*'}));app.use(express.json({limit:'20mb'}));
app.use(express.static(path.join(__dirname)));
app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'index.html')));

const clients=new Map(),online=new Set(),callRooms=new Map(),peerRooms=new Map();
function sendTo(uid,d){const m=JSON.stringify(d);clients.get(uid)?.forEach(ws=>{if(ws.readyState===WebSocket.OPEN)ws.send(m);});}
function broadcast(d,ex){const m=JSON.stringify(d);clients.forEach((s,id)=>{if(id===ex)return;s.forEach(ws=>{if(ws.readyState===WebSocket.OPEN)ws.send(m);});});}
function pushNotif(uid,text){const n={id:'n_'+uid(),uid,text,ts:now()};q.insNotif.run(n);sendTo(uid,{type:'notification',text,ts:n.ts});}
function chatRecips(chatId,ex){
  if(chatId.startsWith('g_'))return q.groupMembers.all(chatId).map(r=>r.userId).filter(id=>id!==ex);
  if(chatId.startsWith('cc_'))return q.commMembers.all(chatId.replace('cc_','')).map(m=>m.uid).filter(id=>id!==ex);
  return chatId.replace(/^chat_/,'').split('_').filter(id=>id!==ex&&!!q.uById.get(id));
}
function leaveRoom(uid,roomId){const r=callRooms.get(roomId);if(!r)return;r.delete(uid);if(!r.size)callRooms.delete(roomId);else r.forEach(p=>sendTo(p,{type:'call_room_peer_left',peerId:uid,roomId}));const pr=peerRooms.get(uid);if(pr){pr.delete(roomId);if(!pr.size)peerRooms.delete(uid);}}

wss.on('connection',ws=>{
  ws.uid=null;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw);}catch{return;}
    if(m.type==='auth'){try{const d=jwt.verify(m.token,JWT_SECRET);ws.uid=d.id;if(!clients.has(ws.uid))clients.set(ws.uid,new Set());clients.get(ws.uid).add(ws);online.add(ws.uid);ws.send(JSON.stringify({type:'authed',userId:ws.uid}));ws.send(JSON.stringify({type:'online_list',users:[...online]}));broadcast({type:'user_online',uid:ws.uid},ws.uid);}catch{ws.send(JSON.stringify({type:'auth_error'}));}return;}
    if(!ws.uid)return;
    if(m.type==='call_offer'){const c=q.uById.get(ws.uid);sendTo(m.to,{type:'call_incoming',from:ws.uid,callerName:c?.name,callerAva:c?.avatar,offer:m.offer,callType:m.callType});}
    if(m.type==='call_answer')sendTo(m.to,{type:'call_answer',answer:m.answer,from:ws.uid});
    if(m.type==='call_ice')sendTo(m.to,{type:'call_ice',candidate:m.candidate,from:ws.uid});
    if(m.type==='call_reject')sendTo(m.to,{type:'call_rejected',from:ws.uid});
    if(m.type==='call_end')sendTo(m.to,{type:'call_ended',from:ws.uid});
    if(m.type==='typing')chatRecips(m.chatId,ws.uid).forEach(id=>sendTo(id,{type:'typing',chatId:m.chatId,name:q.uById.get(ws.uid)?.name}));
    if(m.type==='call_room_join'){const{roomId}=m;if(!callRooms.has(roomId))callRooms.set(roomId,new Set());const r=callRooms.get(roomId);const peers=[...r].filter(id=>id!==ws.uid);sendTo(ws.uid,{type:'call_room_peers',peers,roomId});peers.forEach(id=>sendTo(id,{type:'call_room_peer_joined',peerId:ws.uid,roomId}));r.add(ws.uid);if(!peerRooms.has(ws.uid))peerRooms.set(ws.uid,new Set());peerRooms.get(ws.uid).add(roomId);}
    if(m.type==='call_room_leave')leaveRoom(ws.uid,m.roomId);
    if(m.type==='call_room_signal')sendTo(m.to,{type:'call_room_signal',from:ws.uid,roomId:m.roomId,signal:m.signal});
  });
  ws.on('close',()=>{if(ws.uid&&clients.has(ws.uid)){clients.get(ws.uid).delete(ws);if(!clients.get(ws.uid).size){clients.delete(ws.uid);online.delete(ws.uid);broadcast({type:'user_offline',uid:ws.uid},ws.uid);const r=peerRooms.get(ws.uid);if(r)[...r].forEach(rId=>leaveRoom(ws.uid,rId));}}});
  ws.on('error',()=>{});
});

const auth=(req,res,next)=>{const t=(req.headers.authorization||'').split(' ')[1];if(!t)return res.status(401).json({error:'No token'});try{req.user=jwt.verify(t,JWT_SECRET);next();}catch{res.status(401).json({error:'Invalid token'});}};
const ownerOnly=(req,res,next)=>{if(!isOwnerU(req.user.id))return res.status(403).json({error:'Owner only'});next();};
const staffOnly=(req,res,next)=>{if(!isStaff(req.user.id))return res.status(403).json({error:'Staff only'});next();};

// AUTH
app.post('/api/auth/register',async(req,res)=>{try{let{email,password,name,username,bio,avatar}=req.body;if(!email||!password||!name||!username)return res.status(400).json({error:'Fill all fields'});email=email.trim().toLowerCase();if(q.uByEmail.get(email))return res.status(400).json({error:'Email taken'});const un=username.trim().startsWith('@')?username.trim():'@'+username.trim();if(q.uByUname.get(un))return res.status(400).json({error:'Username taken'});const hash=await bcrypt.hash(password,10);const u={id:'u_'+uid(),email,password:hash,name:name.trim(),username:un,bio:bio||'',avatar:avatar||'',banner:'',createdAt:now()};q.insUser.run(u);const token=jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'30d'});res.json({token,user:safe(q.uById.get(u.id))});}catch(e){res.status(500).json({error:e.message});}});
app.post('/api/auth/login',async(req,res)=>{try{let{id:lid,password}=req.body;if(!lid||!password)return res.status(400).json({error:'Fill fields'});lid=lid.trim();const u=q.uByEmail.get(lid.toLowerCase())||q.uByUname.get(lid.startsWith('@')?lid:'@'+lid);if(!u)return res.status(401).json({error:'User not found'});if(!(await bcrypt.compare(password,u.password)))return res.status(401).json({error:'Wrong password'});if(isBanned(u.id)){const b=q.activeBan.get(u.id);return res.status(403).json({error:`Banned. Reason: ${b.reason||'none'}`});}const token=jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'30d'});res.json({token,user:safe(u)});}catch(e){res.status(500).json({error:e.message});}});

// USERS
app.get('/api/users',auth,(req,res)=>res.json(q.allUsers.all().map(u=>({...safe(u),followersCount:q.followers.all(u.id).length,followingCount:q.following.all(u.id).length,isFollowing:!!q.isFollowing.get(req.user.id,u.id),isBanned:isBanned(u.id),isMuted:isMuted(u.id)}))));
app.put('/api/users/:id',auth,async(req,res)=>{if(req.user.id!==req.params.id)return res.status(403).json({error:'Forbidden'});const u=q.uById.get(req.params.id);if(!u)return res.status(404).json({error:'Not found'});const{name,username,bio,avatar,banner,password}=req.body;const un=username?(username.trim().startsWith('@')?username.trim():'@'+username.trim()):u.username;if(un!==u.username&&q.uByUname.get(un)?.id!==u.id)return res.status(400).json({error:'Username taken'});q.updUser.run({name:(name||u.name).trim(),username:un,bio:bio!==undefined?bio:u.bio,avatar:avatar!==undefined?avatar:u.avatar,banner:banner!==undefined?banner:u.banner,id:u.id});if(password)q.updPass.run({password:await bcrypt.hash(password,10),id:u.id});res.json(safe(q.uById.get(u.id)));});

// SUBS
app.post('/api/users/:id/follow',auth,(req,res)=>{const t=req.params.id;if(t===req.user.id)return res.status(400).json({error:'Cannot follow self'});if(q.isFollowing.get(req.user.id,t)){q.unsub.run(req.user.id,t);return res.json({following:false});}q.sub.run(req.user.id,t,now());pushNotif(t,`👤 ${q.uById.get(req.user.id)?.name} subscribed`);res.json({following:true});});
app.get('/api/users/:id/followers',auth,(req,res)=>res.json(q.followers.all(req.params.id).map(r=>safe(q.uById.get(r.followerId))).filter(Boolean)));
app.get('/api/users/:id/following',auth,(req,res)=>res.json(q.following.all(req.params.id).map(r=>safe(q.uById.get(r.followingId))).filter(Boolean)));

// STORIES
app.get('/api/stories',auth,(req,res)=>res.json(q.activeStories.all().map(s=>({...s,author:safe(q.uById.get(s.authorId)),viewCount:q.storyViews.all(s.id).length,likeCount:q.storyLikes.all(s.id).length,liked:!!q.storyLikes.all(s.id).find(r=>r.userId===req.user.id),viewed:!!q.storyViews.all(s.id).find(r=>r.userId===req.user.id)}))));
app.post('/api/stories',auth,(req,res)=>{if(isMuted(req.user.id))return res.status(403).json({error:'Muted'});const{mediaUrl,mediaType,text}=req.body;if(!mediaUrl)return res.status(400).json({error:'Media required'});const s={id:'s_'+uid(),authorId:req.user.id,mediaUrl,mediaType:mediaType||'image',text:text||'',ts:now(),expiresAt:new Date(Date.now()+86400000).toISOString()};q.insStory.run(s);res.json(s);});
app.delete('/api/stories/:id',auth,(req,res)=>{const s=q.storyById.get(req.params.id);if(!s)return res.status(404).json({error:'NF'});if(s.authorId!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});q.delStory.run(req.params.id);res.json({ok:true});});
app.post('/api/stories/:id/view',auth,(req,res)=>{q.viewStory.run(req.params.id,req.user.id,now());res.json({ok:true});});
app.post('/api/stories/:id/like',auth,(req,res)=>{const liked=q.storyLikes.all(req.params.id).find(r=>r.userId===req.user.id);if(liked){q.unlikeStory.run(req.params.id,req.user.id);return res.json({liked:false});}q.likeStory.run(req.params.id,req.user.id);const s=q.storyById.get(req.params.id);if(s&&s.authorId!==req.user.id)pushNotif(s.authorId,`❤️ ${q.uById.get(req.user.id)?.name} liked your story`);res.json({liked:true});});
app.get('/api/stories/:id/stats',auth,(req,res)=>{const s=q.storyById.get(req.params.id);if(!s)return res.status(404).json({error:'NF'});if(s.authorId!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});res.json({views:q.storyViews.all(req.params.id),likes:q.storyLikes.all(req.params.id).map(r=>safe(q.uById.get(r.userId))).filter(Boolean)});});

// POSTS
app.get('/api/posts',auth,(_,res)=>res.json(q.allPosts.all().map(ePost)));
app.post('/api/posts',auth,(req,res)=>{if(isMuted(req.user.id))return res.status(403).json({error:'Muted'});const{text,media,communityId}=req.body;if(!text&&!media)return res.status(400).json({error:'Empty post'});const p={id:'p_'+uid(),authorId:req.user.id,text:text||'',mediaUrl:media?.url||null,mediaType:media?.t||null,communityId:communityId||null,ts:now()};q.insPost.run(p);const ep=ePost(p);broadcast({type:'new_post',post:ep},req.user.id);res.json(ep);});
app.post('/api/posts/:id/like',auth,(req,res)=>{const p=q.postById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});if(q.likes.all(p.id).find(r=>r.userId===req.user.id))q.delLike.run(p.id,req.user.id);else{q.addLike.run(p.id,req.user.id);if(p.authorId!==req.user.id)pushNotif(p.authorId,`❤️ ${q.uById.get(req.user.id)?.name} liked your post`);}res.json(ePost(p));});
app.post('/api/posts/:id/comment',auth,(req,res)=>{if(isMuted(req.user.id))return res.status(403).json({error:'Muted'});const p=q.postById.get(req.params.id);if(!p||!req.body.text?.trim())return res.status(400).json({error:'Error'});const c={id:'c_'+uid(),postId:p.id,uid:req.user.id,text:req.body.text.trim(),ts:now()};q.insCmt.run(c);if(p.authorId!==req.user.id)pushNotif(p.authorId,`💬 ${q.uById.get(req.user.id)?.name} commented`);res.json(ePost(p));});
app.delete('/api/posts/:pid/comment/:cid',auth,(req,res)=>{const c=q.cmtById.get(req.params.cid);if(!c)return res.status(404).json({error:'NF'});const p=q.postById.get(req.params.pid);if(c.uid!==req.user.id&&!canManage(req.user.id)&&p?.authorId!==req.user.id)return res.status(403).json({error:'Forbidden'});q.delCmt.run(req.params.cid);res.json(p?ePost(p):{ok:true});});
app.delete('/api/posts/:id',auth,(req,res)=>{const p=q.postById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});if(p.authorId!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});q.delPost.run(req.params.id);res.json({ok:true});});

// FRIENDS
app.get('/api/friendships',auth,(req,res)=>res.json(q.friendsOf.all(req.user.id,req.user.id)));
app.post('/api/friendships',auth,(req,res)=>{const{to}=req.body;if(!to||to===req.user.id)return res.status(400).json({error:'Error'});const f={id:'f_'+uid(),fromId:req.user.id,toId:to,ts:now()};q.insFriend.run(f);pushNotif(to,`👤 ${q.uById.get(req.user.id)?.name} wants to be friends`);sendTo(to,{type:'friend_request',friendship:f,senderName:q.uById.get(req.user.id)?.name});res.json(f);});
app.put('/api/friendships/:id/accept',auth,(req,res)=>{const f=q.friendById.get(req.params.id);if(!f||f.toId!==req.user.id)return res.status(404).json({error:'NF'});q.acceptF.run(f.id);const to=q.uById.get(f.toId);pushNotif(f.fromId,`✅ ${to?.name} accepted`);sendTo(f.fromId,{type:'friend_accepted',byName:to?.name});res.json(q.friendById.get(f.id));});
app.delete('/api/friendships/:id',auth,(req,res)=>{const f=q.friendById.get(req.params.id);if(!f||(f.fromId!==req.user.id&&f.toId!==req.user.id))return res.status(404).json({error:'NF'});q.delFriend.run(f.id);res.json({ok:true});});

// MESSAGES
app.get('/api/messages',auth,(req,res)=>{const{chatId}=req.query;if(!chatId)return res.status(400).json({error:'chatId req'});res.json(q.msgByChat.all(chatId));});
app.post('/api/messages',auth,(req,res)=>{if(isMuted(req.user.id))return res.status(403).json({error:'Muted'});const{chatId,text,img,voice}=req.body;if(!chatId||(!text&&!img&&!voice))return res.status(400).json({error:'Empty'});const m={id:'m_'+uid(),chatId,senderId:req.user.id,text:text||null,img:img||null,voice:voice||null,ts:now()};q.insMsg.run(m);chatRecips(chatId,req.user.id).forEach(id=>{sendTo(id,{type:'new_message',message:m});if(!chatId.startsWith('g_')&&!chatId.startsWith('cc_'))pushNotif(id,`💌 ${q.uById.get(req.user.id)?.name} sent a message`);});res.json(m);});
app.delete('/api/messages/:id',auth,(req,res)=>{const m=q.msgById.get(req.params.id);if(!m||(m.senderId!==req.user.id&&!canManage(req.user.id)))return res.status(403).json({error:'Forbidden'});q.delMsg.run(req.params.id);res.json({ok:true});});

// COMMUNITIES
app.get('/api/communities',auth,(_,res)=>res.json(q.allComms.all().map(c=>({...c,verified:!!c.verified}))));
app.post('/api/communities',auth,(req,res)=>{const{name,description,avatar}=req.body;if(!name?.trim())return res.status(400).json({error:'Name required'});const c={id:'c_'+uid(),name:name.trim(),description:description||'',avatar:avatar||'',banner:'',createdBy:req.user.id,ts:now()};q.insComm.run(c);q.insMember.run(c.id,req.user.id,now());q.updRank.run('owner',c.id,req.user.id);res.json({...c,verified:false});});
app.get('/api/communities/:id/members',auth,(req,res)=>{const c=q.commById.get(req.params.id);res.json(q.commMembers.all(req.params.id).map(m=>({uid:m.uid,rank:c?.createdBy===m.uid?'owner':(m.rank||'member'),ts:m.ts})));});
app.post('/api/communities/:id/join',auth,(req,res)=>{q.insMember.run(req.params.id,req.user.id,now());res.json({ok:true});});
app.post('/api/communities/:id/leave',auth,(req,res)=>{const c=q.commById.get(req.params.id);if(c?.createdBy===req.user.id)return res.status(400).json({error:'Owner cannot leave'});q.delMember.run(req.params.id,req.user.id);res.json({ok:true});});
app.post('/api/communities/:id/rank',auth,(req,res)=>{const{userId,rank}=req.body;if(!['admin','moderator','member'].includes(rank))return res.status(400).json({error:'Invalid rank'});const myR=q.commById.get(req.params.id)?.createdBy===req.user.id?'owner':(q.memberRank.get(req.params.id,req.user.id)?.rank||'member');if(!['owner','admin'].includes(myR)&&!canManage(req.user.id))return res.status(403).json({error:'No rights'});q.updRank.run(rank,req.params.id,userId);const c=q.commById.get(req.params.id);pushNotif(userId,`⚡ Rank in "${c?.name}": ${rank}`);res.json({ok:true});});
app.delete('/api/communities/:id',auth,(req,res)=>{const c=q.commById.get(req.params.id);if(!c)return res.status(404).json({error:'NF'});if(c.createdBy!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});q.delComm.run(req.params.id);res.json({ok:true});});

// GROUPS
app.get('/api/groups',auth,(req,res)=>res.json(q.groupsForUser.all(req.user.id)));
app.post('/api/groups',auth,(req,res)=>{const{name}=req.body;if(!name?.trim())return res.status(400).json({error:'Name'});const g={id:'g_'+uid(),name:name.trim(),createdBy:req.user.id,ts:now()};q.insGroup.run(g);q.addGM.run(g.id,req.user.id);res.json(g);});
app.post('/api/groups/:id/add',auth,(req,res)=>{const g=q.groupById.get(req.params.id);if(!g||g.createdBy!==req.user.id)return res.status(403).json({error:'Forbidden'});q.addGM.run(g.id,req.body.userId);res.json(g);});

// NOTIFS
app.get('/api/notifications',auth,(req,res)=>res.json(q.notifs.all(req.user.id)));
app.post('/api/notifications/read',auth,(req,res)=>{q.readNotifs.run(req.user.id);res.json({ok:true});});

// VERIFY
app.post('/api/verify-request',auth,(req,res)=>{if(q.vrByUser.get(req.user.id))return res.status(400).json({error:'Already sent'});q.insVR.run({id:'vr_'+uid(),uid:req.user.id,ts:now()});res.json({ok:true});});

// FORUM
app.get('/api/forum',auth,(_,res)=>res.json(q.allForum.all().map(p=>({...p,pinned:!!p.pinned,author:safe(q.uById.get(p.authorId)),replyCount:q.forumReplies.all(p.id).length}))));
app.post('/api/forum',auth,(req,res)=>{if(isMuted(req.user.id))return res.status(403).json({error:'Muted'});const{title,text,category,img}=req.body;if(!title?.trim()||!text?.trim())return res.status(400).json({error:'Fill fields'});const p={id:'fp_'+uid(),authorId:req.user.id,title:title.trim(),text:text.trim(),category:category||'general',img:img||null,ts:now()};q.insForum.run(p);q.allUsers.all().filter(u=>isStaff(u.id)).forEach(u=>pushNotif(u.id,`💬 New topic: "${title.substring(0,40)}"`));res.json(eForum(p));});
app.get('/api/forum/:id',auth,(req,res)=>{const p=q.forumById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});res.json(eForum(p));});
app.post('/api/forum/:id/reply',auth,(req,res)=>{if(isMuted(req.user.id))return res.status(403).json({error:'Muted'});const p=q.forumById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});if(!isStaff(req.user.id)&&p.authorId!==req.user.id)return res.status(403).json({error:'Staff only'});if(!req.body.text?.trim())return res.status(400).json({error:'Empty'});const r={id:'fr_'+uid(),postId:p.id,authorId:req.user.id,text:req.body.text.trim(),img:req.body.img||null,ts:now()};q.insForumReply.run(r);if(p.authorId!==req.user.id)pushNotif(p.authorId,`💬 ${q.uById.get(req.user.id)?.name} replied to "${p.title.substring(0,30)}"`);res.json(eForum(p));});
app.delete('/api/forum/:id/reply/:rid',auth,(req,res)=>{const r=q.forumReplyById.get(req.params.rid);if(!r)return res.status(404).json({error:'NF'});if(r.authorId!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});q.delForumReply.run(req.params.rid);res.json({ok:true});});
app.post('/api/forum/:id/status',auth,staffOnly,(req,res)=>{const p=q.forumById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});q.forumStatus.run(p.status==='open'?'closed':'open',p.id);res.json(eForum(q.forumById.get(p.id)));});
app.post('/api/forum/:id/pin',auth,(req,res)=>{if(!canManage(req.user.id))return res.status(403).json({error:'No rights'});const p=q.forumById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});q.forumPin.run(p.pinned?0:1,p.id);res.json(eForum(q.forumById.get(p.id)));});
app.delete('/api/forum/:id',auth,(req,res)=>{const p=q.forumById.get(req.params.id);if(!p)return res.status(404).json({error:'NF'});if(p.authorId!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});q.delForum.run(req.params.id);res.json({ok:true});});

// COMPLAINTS
app.get('/api/complaints',auth,(req,res)=>{const rows=isStaff(req.user.id)?q.allComplaints.all():q.myComplaints.all(req.user.id);res.json(rows.map(c=>({...c,author:safe(q.uById.get(c.authorId)),replies:q.compReplies.all(c.id).map(r=>({...r,author:safe(q.uById.get(r.authorId))}))})));});
app.post('/api/complaints',auth,(req,res)=>{const{text,img,targetId,type}=req.body;if(!text?.trim())return res.status(400).json({error:'Describe'});const c={id:'comp_'+uid(),authorId:req.user.id,text:text.trim(),img:img||null,type:type||'other',targetId:targetId||null,ts:now()};q.insComplaint.run(c);q.allUsers.all().filter(u=>isStaff(u.id)).forEach(u=>pushNotif(u.id,`🚩 New complaint from ${q.uById.get(req.user.id)?.name}`));res.json(c);});
app.delete('/api/complaints/:id',auth,(req,res)=>{const c=q.complaintById.get(req.params.id);if(!c)return res.status(404).json({error:'NF'});if(c.authorId!==req.user.id&&!canManage(req.user.id))return res.status(403).json({error:'Forbidden'});q.delComplaint.run(req.params.id);res.json({ok:true});});
app.post('/api/complaints/:id/reply',auth,staffOnly,(req,res)=>{const c=q.complaintById.get(req.params.id);if(!c||!req.body.text?.trim())return res.status(400).json({error:'Error'});const r={id:'cr_'+uid(),complaintId:c.id,authorId:req.user.id,text:req.body.text.trim(),ts:now()};q.insCompReply.run(r);pushNotif(c.authorId,`✅ ${q.uById.get(req.user.id)?.name} replied to your complaint`);res.json(r);});
app.post('/api/complaints/:id/status',auth,staffOnly,(req,res)=>{const{status}=req.body;if(!['pending','reviewing','resolved','rejected'].includes(status))return res.status(400).json({error:'Invalid'});const c=q.complaintById.get(req.params.id);if(!c)return res.status(404).json({error:'NF'});q.complaintStatus.run(status,c.id);pushNotif(c.authorId,`📋 Complaint: ${status}`);res.json({ok:true});});

// ADMIN
app.post('/api/admin/broadcast',auth,ownerOnly,(req,res)=>{const{text}=req.body;if(!text?.trim())return res.status(400).json({error:'Empty'});const me=q.uById.get(req.user.id);let sent=0;q.allUsers.all().forEach(u=>{if(u.id===req.user.id)return;const chatId='chat_'+[req.user.id,u.id].sort().join('_');const m={id:'m_'+uid(),chatId,senderId:req.user.id,text:text.trim(),img:null,voice:null,ts:now()};q.insMsg.run(m);sendTo(u.id,{type:'new_message',message:m});pushNotif(u.id,`📢 ${me?.name}: ${text.substring(0,60)}`);sent++;});res.json({ok:true,sent});});
app.get('/api/admin/stats',auth,ownerOnly,(_,res)=>res.json({users:q.allUsers.all().length,posts:q.allPosts.all().length,online:online.size,stories:q.activeStories.all().length,pendingComplaints:q.allComplaints.all().filter(c=>c.status==='pending').length,pendingVerify:q.pendingVR.all().length}));
app.get('/api/admin/verReqs',auth,ownerOnly,(_,res)=>res.json(q.pendingVR.all()));
app.post('/api/admin/verReqs/:id/approve',auth,ownerOnly,(req,res)=>{const r=q.pendingVR.all().find(x=>x.id===req.params.id);if(!r)return res.status(404).json({error:'NF'});q.approveVR.run(r.id);q.setVer.run({v:1,id:r.uid});pushNotif(r.uid,'🎉 Verified!');sendTo(r.uid,{type:'verified'});res.json({ok:true});});
app.post('/api/admin/verReqs/:id/reject',auth,ownerOnly,(req,res)=>{const r=q.pendingVR.all().find(x=>x.id===req.params.id);if(!r)return res.status(404).json({error:'NF'});q.delVR.run(r.id);pushNotif(r.uid,'❌ Verification rejected');res.json({ok:true});});
app.post('/api/admin/users/:id/verify',auth,ownerOnly,(req,res)=>{const u=q.uById.get(req.params.id);if(!u)return res.status(404).json({error:'NF'});q.setVer.run({v:u.verified?0:1,id:u.id});if(!u.verified){pushNotif(u.id,'🎉 You are verified!');sendTo(u.id,{type:'verified'});}res.json({ok:true});});
app.post('/api/admin/users/:id/ban',auth,ownerOnly,(req,res)=>{const{reason,duration}=req.body;const u=q.uById.get(req.params.id);if(!u||u.email===OWNER_EMAIL)return res.status(400).json({error:'Cannot'});q.delBan.run(u.id);const exp=duration?new Date(Date.now()+duration*3600000).toISOString():null;q.insBan.run({id:'b_'+uid(),uid:u.id,reason:reason||'',bannedBy:req.user.id,expiresAt:exp,ts:now()});pushNotif(u.id,`🚫 Banned${duration?` for ${duration}h`:''}: ${reason||'no reason'}`);sendTo(u.id,{type:'banned',reason,expiresAt:exp});res.json({ok:true});});
app.post('/api/admin/users/:id/unban',auth,ownerOnly,(req,res)=>{q.delBan.run(req.params.id);pushNotif(req.params.id,'✅ Unbanned');res.json({ok:true});});
app.post('/api/admin/users/:id/mute',auth,(req,res)=>{if(!canManage(req.user.id))return res.status(403).json({error:'No rights'});const{reason,duration}=req.body;const u=q.uById.get(req.params.id);if(!u||u.email===OWNER_EMAIL)return res.status(400).json({error:'Cannot'});q.delMute.run(u.id);const exp=duration?new Date(Date.now()+duration*3600000).toISOString():null;q.insMute.run({id:'mu_'+uid(),uid:u.id,reason:reason||'',mutedBy:req.user.id,expiresAt:exp,ts:now()});pushNotif(u.id,`🔇 Muted${duration?` for ${duration}h`:''}: ${reason||'no reason'}`);sendTo(u.id,{type:'muted',reason,expiresAt:exp});res.json({ok:true});});
app.post('/api/admin/users/:id/unmute',auth,(req,res)=>{if(!canManage(req.user.id))return res.status(403).json({error:'No rights'});q.delMute.run(req.params.id);pushNotif(req.params.id,'🔊 Unmuted');res.json({ok:true});});
app.post('/api/admin/users/:id/siteRole',auth,ownerOnly,(req,res)=>{const{role}=req.body;if(!['admin','moderator','helper','user'].includes(role))return res.status(400).json({error:'Invalid'});const u=q.uById.get(req.params.id);if(!u||u.email===OWNER_EMAIL)return res.status(400).json({error:'Cannot'});q.setRole.run({role,id:u.id});pushNotif(u.id,`⚡ Role: ${role}`);sendTo(u.id,{type:'site_role_updated',role});res.json({ok:true});});
app.delete('/api/admin/users/:id',auth,ownerOnly,(req,res)=>{const u=q.uById.get(req.params.id);if(!u||u.email===OWNER_EMAIL)return res.status(400).json({error:'Cannot'});q.delUser.run(req.params.id);res.json({ok:true});});
app.delete('/api/admin/posts/:id',auth,ownerOnly,(req,res)=>{q.delPost.run(req.params.id);res.json({ok:true});});
app.post('/api/admin/communities/:id/verify',auth,ownerOnly,(req,res)=>{const c=q.commById.get(req.params.id);if(!c)return res.status(404).json({error:'NF'});q.setCommVer.run({v:c.verified?0:1,id:c.id});res.json({ok:true});});
app.delete('/api/admin/communities/:id',auth,ownerOnly,(req,res)=>{q.delComm.run(req.params.id);res.json({ok:true});});
app.get('/api/health',(_,res)=>res.json({ok:true,ts:now(),online:online.size}));

async function main(){
  if(!q.uByEmail.get(OWNER_EMAIL)){const hash=await bcrypt.hash(OWNER_PASS,10);q.insUser.run({id:'user_owner',email:OWNER_EMAIL,password:hash,name:'Foxi',username:'@foxi',bio:'',avatar:'',banner:'',createdAt:now()});q.setRole.run({role:'owner',id:'user_owner'});q.setVer.run({v:1,id:'user_owner'});console.log('[KNB] Owner created');}
  server.listen(PORT,'0.0.0.0',()=>console.log(`[KNB] ✅ Port ${PORT}`));
}
main().catch(console.error);
