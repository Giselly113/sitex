require("dotenv").config();

const express = require("express");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const OpenAI = require("openai");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DATA = path.join(__dirname, "data");
fs.mkdirSync(DATA, { recursive: true });

const db = new Database(path.join(DATA, "siteforge.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE,
 password TEXT NOT NULL,
 plan TEXT NOT NULL DEFAULT 'free',
 credits INTEGER NOT NULL DEFAULT 5,
 role TEXT NOT NULL DEFAULT 'user',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 slug TEXT NOT NULL UNIQUE,
 project_json TEXT NOT NULL,
 published INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL,
 plan TEXT NOT NULL,
 provider TEXT NOT NULL,
 provider_id TEXT,
 status TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
`);

const PLANS = {
  free: { name:"Grátis", price:0, credits:5, sites:1 },
  pro: { name:"Pro", price:29.90, credits:100, sites:10 },
  business: { name:"Business", price:79.90, credits:500, sites:50 }
};

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.json({limit:"8mb"}));
app.use(express.urlencoded({extended:true}));
app.use(cookieSession({
  name:"siteforge_session",
  keys:[process.env.SESSION_SECRET || "CHANGE_ME_IN_PRODUCTION"],
  httpOnly:true,
  sameSite:"lax",
  secure:false,
  maxAge:1000*60*60*24*30
}));
app.use(express.static(path.join(__dirname,"public")));

function now(){return new Date().toISOString();}
function uid(){return crypto.randomUUID();}
function slugify(v){
 return String(v||"site").normalize("NFD").replace(/[\u0300-\u036f]/g,"")
  .toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,45) || "site";
}
function uniqueSlug(base){
 let s=slugify(base), n=1;
 while(db.prepare("SELECT id FROM projects WHERE slug=?").get(s)) s=slugify(base)+"-"+n++;
 return s;
}
function userFromSession(req){
 return req.session?.userId ? db.prepare("SELECT id,name,email,plan,credits,role FROM users WHERE id=?").get(req.session.userId) : null;
}
function requireAuth(req,res,next){
 const user=userFromSession(req);
 if(!user) return res.status(401).json({error:"Faça login para continuar."});
 req.user=user; next();
}
function requireAdmin(req,res,next){
 const user=userFromSession(req);
 if(!user || user.role!=="admin") return res.status(403).json({error:"Acesso restrito."});
 req.user=user; next();
}
function cleanJSON(text){
 const s=String(text||"").replace(/^```json/i,"").replace(/```$/,"").trim();
 const a=s.indexOf("{"), b=s.lastIndexOf("}");
 if(a<0||b<=a) throw new Error("A IA não retornou JSON válido.");
 return JSON.parse(s.slice(a,b+1));
}
const SYSTEM = `Você é a IA de um construtor de sites SaaS chamado SiteForge AI.
Responda SOMENTE JSON válido, sem markdown.
Estrutura:
{
 "name":"string",
 "description":"string",
 "theme":{"primary":"#hex","secondary":"#hex","background":"#hex","text":"#hex"},
 "settings":{"whatsapp":"string","instagram":"string","address":"string"},
 "pages":[
  {"id":"string","name":"Início","slug":"inicio","blocks":[
   {"type":"hero","title":"string","subtitle":"string","buttonText":"string","buttonUrl":"#"},
   {"type":"about","title":"string","text":"string"},
   {"type":"services","title":"string","items":[{"title":"string","text":"string"}]},
   {"type":"products","title":"string","items":[{"title":"string","text":"string","price":"string"}]},
   {"type":"testimonials","title":"string","items":[{"name":"string","text":"string"}]},
   {"type":"contact","title":"string","text":"string"},
   {"type":"cta","title":"string","text":"string","buttonText":"string"}
  ]}
 ]
}
Use somente os tipos permitidos. Gere português brasileiro profissional. Não invente telefone, endereço ou dados pessoais.`;

function defaultProject(d){
 return {
  name:d.name||"Meu site", description:d.description||"",
  theme:{primary:d.primaryColor||"#7c3aed",secondary:"#111827",background:"#ffffff",text:"#111827"},
  settings:{whatsapp:d.whatsapp||"",instagram:d.instagram||"",address:d.address||""},
  pages:[{id:uid(),name:"Início",slug:"inicio",blocks:[
   {type:"hero",title:d.name||"Seu novo site",subtitle:d.description||"Um site profissional criado com IA.",buttonText:"Fale conosco",buttonUrl:"#contato"},
   {type:"about",title:"Sobre",text:d.description||"Apresente aqui sua empresa."},
   {type:"services",title:"Nossos serviços",items:[{title:"Serviço 1",text:"Descrição do serviço."},{title:"Serviço 2",text:"Descrição do serviço."},{title:"Serviço 3",text:"Descrição do serviço."}]},
   {type:"contact",title:"Entre em contato",text:"Fale conosco para saber mais."}
  ]}]
 };
}

app.get("/api/health",(req,res)=>res.json({ok:true,ai:!!openai,payment:!!process.env.MERCADOPAGO_ACCESS_TOKEN}));
app.get("/api/me",(req,res)=>res.json({user:userFromSession(req)}));

app.post("/api/auth/register",async(req,res)=>{
 try{
  const {name,email,password}=req.body||{};
  if(!name||!email||!password||password.length<6) return res.status(400).json({error:"Informe nome, e-mail e senha com pelo menos 6 caracteres."});
  const normalized=email.trim().toLowerCase();
  if(db.prepare("SELECT id FROM users WHERE email=?").get(normalized)) return res.status(409).json({error:"Este e-mail já está cadastrado."});
  const count=db.prepare("SELECT COUNT(*) c FROM users").get().c;
  const hash=await bcrypt.hash(password,12);
  const info=db.prepare("INSERT INTO users(name,email,password,plan,credits,role,created_at) VALUES(?,?,?,?,?,?,?)")
   .run(name.trim(),normalized,hash,"free",PLANS.free.credits,count===0?"admin":"user",now());
  req.session.userId=info.lastInsertRowid;
  res.json({ok:true,user:userFromSession(req)});
 }catch(e){res.status(500).json({error:e.message});}
});

app.post("/api/auth/login",async(req,res)=>{
 const {email,password}=req.body||{};
 const u=db.prepare("SELECT * FROM users WHERE email=?").get(String(email||"").trim().toLowerCase());
 if(!u || !(await bcrypt.compare(password||"",u.password))) return res.status(401).json({error:"E-mail ou senha inválidos."});
 req.session.userId=u.id;
 res.json({ok:true,user:userFromSession(req)});
});
app.post("/api/auth/logout",(req,res)=>{req.session=null;res.json({ok:true});});

app.get("/api/plans",(req,res)=>res.json(PLANS));

app.get("/api/projects",requireAuth,(req,res)=>{
 const rows=db.prepare("SELECT id,name,slug,published,created_at,updated_at FROM projects WHERE user_id=? ORDER BY updated_at DESC").all(req.user.id);
 res.json(rows);
});
app.get("/api/projects/:id",requireAuth,(req,res)=>{
 const p=db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
 if(!p)return res.status(404).json({error:"Projeto não encontrado."});
 res.json({...p,project:JSON.parse(p.project_json)});
});

app.post("/api/projects",requireAuth,(req,res)=>{
 const user=req.user, plan=PLANS[user.plan]||PLANS.free;
 const count=db.prepare("SELECT COUNT(*) c FROM projects WHERE user_id=?").get(user.id).c;
 if(count>=plan.sites)return res.status(402).json({error:`Seu plano permite até ${plan.sites} site(s). Faça upgrade para criar mais.`});
 const d=req.body||{};
 const project=defaultProject(d);
 const id=uid(), slug=uniqueSlug(project.name), t=now();
 db.prepare("INSERT INTO projects(id,user_id,name,slug,project_json,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .run(id,user.id,project.name,slug,JSON.stringify(project),0,t,t);
 res.json({id,slug,project});
});

app.post("/api/ai/generate",requireAuth,async(req,res)=>{
 if(!openai)return res.status(503).json({error:"A IA não está configurada. Adicione OPENAI_API_KEY no .env."});
 if(req.user.credits<=0)return res.status(402).json({error:"Você ficou sem créditos de IA. Faça upgrade do plano."});
 try{
  const d=req.body||{};
  const r=await openai.chat.completions.create({
   model:"gpt-4o-mini",temperature:.65,
   messages:[
    {role:"system",content:SYSTEM},
    {role:"user",content:`Crie um site para:
Nome: ${d.name||""}
Negócio: ${d.business||""}
Descrição: ${d.description||""}
Público: ${d.audience||""}
Estilo: ${d.style||"moderno"}
Cor: ${d.primaryColor||""}
WhatsApp: ${d.whatsapp||""}
Instagram: ${d.instagram||""}
Endereço: ${d.address||""}
Funcionalidades: ${d.features||""}`}
   ]
  });
  const project=cleanJSON(r.choices[0].message.content);
  project.pages=(project.pages||[]).map(p=>({...p,id:p.id||uid(),blocks:p.blocks||[]}));
  db.prepare("UPDATE users SET credits=credits-1 WHERE id=?").run(req.user.id);
  res.json({project,credits:req.user.credits-1});
 }catch(e){console.error(e);res.status(500).json({error:e.message});}
});

app.post("/api/ai/edit",requireAuth,async(req,res)=>{
 if(!openai)return res.status(503).json({error:"A IA não está configurada."});
 if(req.user.credits<=0)return res.status(402).json({error:"Sem créditos de IA."});
 try{
  const {project,command}=req.body||{};
  const r=await openai.chat.completions.create({
   model:"gpt-4o-mini",temperature:.4,
   messages:[
    {role:"system",content:SYSTEM},
    {role:"user",content:`Projeto atual:\n${JSON.stringify(project)}\n\nAlteração solicitada:\n${command}\n\nRetorne o projeto completo atualizado e preserve tudo que não foi solicitado.`}
   ]
  });
  const updated=cleanJSON(r.choices[0].message.content);
  updated.pages=(updated.pages||[]).map(p=>({...p,id:p.id||uid(),blocks:p.blocks||[]}));
  db.prepare("UPDATE users SET credits=credits-1 WHERE id=?").run(req.user.id);
  res.json({project:updated,credits:req.user.credits-1});
 }catch(e){res.status(500).json({error:e.message});}
});

app.put("/api/projects/:id",requireAuth,(req,res)=>{
 const p=db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
 if(!p)return res.status(404).json({error:"Projeto não encontrado."});
 const project=req.body.project;
 if(!project)return res.status(400).json({error:"Projeto inválido."});
 db.prepare("UPDATE projects SET name=?,project_json=?,updated_at=? WHERE id=?").run(project.name||p.name,JSON.stringify(project),now(),p.id);
 res.json({ok:true});
});

app.delete("/api/projects/:id",requireAuth,(req,res)=>{
 const p=db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
 if(!p)return res.status(404).json({error:"Projeto não encontrado."});
 db.prepare("DELETE FROM projects WHERE id=?").run(p.id);res.json({ok:true});
});

function esc(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function renderSite(project){
 const t=project.theme||{},primary=t.primary||"#7c3aed",secondary=t.secondary||"#111827",bg=t.background||"#fff",color=t.text||"#111827";
 let h=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${esc(project.description)}"><title>${esc(project.name)}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;color:${color};background:${bg};line-height:1.6}nav{padding:20px 7%;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#ffffffee;backdrop-filter:blur(12px);z-index:5;border-bottom:1px solid #eee}nav strong{font-size:22px}nav a{color:${primary};font-weight:800;text-decoration:none}.hero{padding:110px 7%;text-align:center;background:linear-gradient(135deg,${primary},${secondary});color:#fff}.hero h1{font-size:clamp(42px,7vw,78px);line-height:1.02;margin:0 auto 20px;max-width:900px}.hero p{font-size:19px;max-width:720px;margin:0 auto 30px}.btn{display:inline-block;background:#fff;color:${primary};padding:13px 22px;border-radius:10px;font-weight:800;text-decoration:none}section{padding:80px 7%;max-width:1200px;margin:auto}h2{text-align:center;font-size:38px}.center{text-align:center;max-width:800px;margin:auto}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.card{padding:24px;border:1px solid #e5e7eb;border-radius:16px;background:#fff}.price{font-size:22px;color:${primary};font-weight:900}.cta{max-width:none;text-align:center;background:${primary};color:#fff}.cta h2{color:#fff}footer{padding:30px;text-align:center;background:${secondary};color:#fff}@media(max-width:800px){.grid{grid-template-columns:1fr}.hero{padding:80px 20px}section{padding:60px 20px}}</style></head><body><nav><strong>${esc(project.name)}</strong><a href="#contato">Contato</a></nav>`;
 const p=project.pages?.[0]||{blocks:[]};
 for(const b of p.blocks||[]){
  if(b.type==="hero")h+=`<section class="hero"><h1>${esc(b.title)}</h1><p>${esc(b.subtitle)}</p><a class="btn" href="${esc(b.buttonUrl||"#contato")}">${esc(b.buttonText||"Saiba mais")}</a></section>`;
  else if(b.type==="about")h+=`<section><div class="center"><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p></div></section>`;
  else if(["services","products","testimonials"].includes(b.type)){h+=`<section><h2>${esc(b.title)}</h2><div class="grid">`;for(const i of b.items||[])h+=`<article class="card"><h3>${esc(i.title||i.name)}</h3><p>${esc(i.text)}</p>${i.price?`<div class="price">${esc(i.price)}</div>`:""}</article>`;h+=`</div></section>`;}
  else if(b.type==="contact")h+=`<section id="contato"><div class="center"><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p><p>${esc(project.settings?.whatsapp||"")}</p><p>${esc(project.settings?.instagram||"")}</p><p>${esc(project.settings?.address||"")}</p></div></section>`;
  else if(b.type==="cta")h+=`<section class="cta"><h2>${esc(b.title)}</h2><p>${esc(b.text)}</p><a class="btn" href="#contato">${esc(b.buttonText||"Fale conosco")}</a></section>`;
 }
 return h+`<footer>Site criado com SiteForge AI</footer></body></html>`;
}
app.post("/api/projects/:id/publish",requireAuth,(req,res)=>{
 const p=db.prepare("SELECT * FROM projects WHERE id=? AND user_id=?").get(req.params.id,req.user.id);
 if(!p)return res.status(404).json({error:"Projeto não encontrado."});
 db.prepare("UPDATE projects SET published=1,updated_at=? WHERE id=?").run(now(),p.id);
 res.json({ok:true,url:`${APP_URL}/site/${p.slug}`});
});
app.get("/site/:slug",(req,res)=>{
 const p=db.prepare("SELECT * FROM projects WHERE slug=? AND published=1").get(req.params.slug);
 if(!p)return res.status(404).send("<h1>Site não encontrado</h1>");
 res.type("html").send(renderSite(JSON.parse(p.project_json)));
});

async function mpPreference(user,planKey){
 const token=process.env.MERCADOPAGO_ACCESS_TOKEN;
 if(!token) throw new Error("Mercado Pago não configurado.");
 const plan=PLANS[planKey];
 const paymentId=uid();
 db.prepare("INSERT INTO payments(id,user_id,plan,provider,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
  .run(paymentId,user.id,planKey,"mercadopago","pending",now(),now());
 const r=await fetch("https://api.mercadopago.com/checkout/preferences",{
  method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},
  body:JSON.stringify({
   items:[{title:`SiteForge AI — Plano ${plan.name}`,quantity:1,currency_id:"BRL",unit_price:Number(plan.price)}],
   external_reference:paymentId,
   back_urls:{success:`${APP_URL}/dashboard.html?payment=success`,failure:`${APP_URL}/planos.html?payment=failure`,pending:`${APP_URL}/planos.html?payment=pending`},
   auto_return:"approved",
   notification_url:`${APP_URL}/api/payments/webhook`
  })
 });
 const data=await r.json();
 if(!r.ok)throw new Error(data.message||"Erro ao criar checkout.");
 db.prepare("UPDATE payments SET provider_id=?,updated_at=? WHERE id=?").run(data.id,now(),paymentId);
 return {url:data.init_point,paymentId};
}
app.post("/api/payments/checkout",requireAuth,async(req,res)=>{
 const plan=req.body.plan;
 if(!PLANS[plan]||plan==="free")return res.status(400).json({error:"Plano inválido."});
 try{res.json(await mpPreference(req.user,plan));}catch(e){res.status(503).json({error:e.message});}
});
app.post("/api/payments/webhook",async(req,res)=>{
 res.sendStatus(200);
 try{
  const id=req.body?.data?.id || req.query?.id;
  if(!id||!process.env.MERCADOPAGO_ACCESS_TOKEN)return;
  const r=await fetch(`https://api.mercadopago.com/v1/payments/${id}`,{headers:{Authorization:"Bearer "+process.env.MERCADOPAGO_ACCESS_TOKEN}});
  const payment=await r.json();
  if(payment.status!=="approved")return;
  const paymentId=payment.external_reference;
  const row=db.prepare("SELECT * FROM payments WHERE id=?").get(paymentId);
  if(!row)return;
  db.prepare("UPDATE payments SET status='approved',provider_id=?,updated_at=? WHERE id=?").run(String(id),now(),paymentId);
  const plan=PLANS[row.plan];
  db.prepare("UPDATE users SET plan=?,credits=? WHERE id=?").run(row.plan,plan.credits,row.user_id);
 }catch(e){console.error("Webhook:",e.message);}
});

app.get("/api/admin/stats",requireAdmin,(req,res)=>{
 const users=db.prepare("SELECT COUNT(*) c FROM users").get().c;
 const projects=db.prepare("SELECT COUNT(*) c FROM projects").get().c;
 const published=db.prepare("SELECT COUNT(*) c FROM projects WHERE published=1").get().c;
 const payments=db.prepare("SELECT COUNT(*) c FROM payments WHERE status='approved'").get().c;
 res.json({users,projects,published,payments});
});
app.get("/api/admin/users",requireAdmin,(req,res)=>{
 res.json(db.prepare("SELECT id,name,email,plan,credits,role,created_at FROM users ORDER BY id DESC").all());
});
app.post("/api/admin/users/:id/plan",requireAdmin,(req,res)=>{
 const plan=req.body.plan;
 if(!PLANS[plan])return res.status(400).json({error:"Plano inválido."});
 db.prepare("UPDATE users SET plan=?,credits=? WHERE id=?").run(plan,PLANS[plan].credits,req.params.id);
 res.json({ok:true});
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`SiteForge AI rodando em ${APP_URL}`));
