const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_BEFORE_PRODUCTION';
const db = new Database(path.join(__dirname, 'revesti.db'));
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

app.use(express.json({limit:'2mb'}));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req,res,next){
  const h=req.headers.authorization||'';
  if(!h.startsWith('Bearer ')) return res.status(401).json({error:'Authentifizierung erforderlich'});
  try { req.user=jwt.verify(h.slice(7),JWT_SECRET); next(); }
  catch { res.status(401).json({error:'Ungültiger Login'}); }
}

app.post('/api/register',(req,res)=>{
  const {name,email,password,role='buyer'}=req.body||{};
  if(!name||!email||!password) return res.status(400).json({error:'Name, E-Mail und Passwort sind erforderlich'});
  if(password.length<8) return res.status(400).json({error:'Passwort muss mindestens 8 Zeichen haben'});
  if(!['buyer','seller'].includes(role)) return res.status(400).json({error:'Ungültige Rolle'});
  try {
    const hash=bcrypt.hashSync(password,12);
    const info=db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)').run(name,email.toLowerCase(),hash,role);
    const user={id:Number(info.lastInsertRowid),name,email:email.toLowerCase(),role};
    const token=jwt.sign(user,JWT_SECRET,{expiresIn:'7d'});
    res.json({user,token});
  } catch(e){ res.status(409).json({error:'E-Mail ist bereits registriert'}); }
});

app.post('/api/login',(req,res)=>{
  const {email,password}=req.body||{};
  const u=db.prepare('SELECT * FROM users WHERE email=?').get((email||'').toLowerCase());
  if(!u||!bcrypt.compareSync(password||'',u.password_hash)) return res.status(401).json({error:'E-Mail oder Passwort falsch'});
  const user={id:u.id,name:u.name,email:u.email,role:u.role};
  res.json({user,token:jwt.sign(user,JWT_SECRET,{expiresIn:'7d'})});
});

app.get('/api/me',auth,(req,res)=>res.json({user:req.user}));

app.get('/api/products',(req,res)=>{
  const products=db.prepare(`SELECT p.*, u.name seller_name FROM products p JOIN users u ON u.id=p.seller_id WHERE p.status='active' ORDER BY p.id DESC`).all();
  res.json({products});
});

app.post('/api/products',auth,(req,res)=>{
  if(!['seller','admin'].includes(req.user.role)) return res.status(403).json({error:'Nur Verkäufer können Produkte einstellen'});
  const {title,category,priceCents,condition,description=''}=req.body||{};
  if(!title||!category||!Number.isInteger(priceCents)||priceCents<0||!condition) return res.status(400).json({error:'Produktdaten unvollständig'});
  const info=db.prepare('INSERT INTO products(seller_id,title,category,price_cents,condition,description) VALUES(?,?,?,?,?,?)').run(req.user.id,title,category,priceCents,condition,description);
  res.status(201).json({id:Number(info.lastInsertRowid),commissionCents:Math.round(priceCents*.10),sellerAmountCents:priceCents-Math.round(priceCents*.10)});
});

app.post('/api/favorites/toggle',auth,(req,res)=>{
  const {productId}=req.body||{};
  const p=db.prepare('SELECT id FROM products WHERE id=?').get(productId);
  if(!p) return res.status(404).json({error:'Produkt nicht gefunden'});
  const exists=db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND product_id=?').get(req.user.id,productId);
  if(exists){ db.prepare('DELETE FROM favorites WHERE user_id=? AND product_id=?').run(req.user.id,productId); return res.json({favorite:false}); }
  db.prepare('INSERT INTO favorites(user_id,product_id) VALUES(?,?)').run(req.user.id,productId);
  res.json({favorite:true});
});

app.get('/api/orders',auth,(req,res)=>{
  const rows=req.user.role==='seller'
    ? db.prepare(`SELECT o.*, oi.product_id, oi.price_cents, p.title FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE oi.seller_id=? ORDER BY o.id DESC`).all(req.user.id)
    : db.prepare(`SELECT o.*, oi.product_id, oi.price_cents, p.title FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.buyer_id=? ORDER BY o.id DESC`).all(req.user.id);
  res.json({orders:rows});
});

app.patch('/api/orders/:id/shipping',auth,(req,res)=>{
  if(req.user.role!=='seller' && req.user.role!=='admin') return res.status(403).json({error:'Nur Verkäufer können den Versand aktualisieren'});
  const {trackingNumber,carrier}=req.body||{};
  const id=Number(req.params.id);
  const row=db.prepare(`SELECT oi.seller_id FROM order_items oi WHERE oi.order_id=? LIMIT 1`).get(id);
  if(!row || (req.user.role!=='admin' && row.seller_id!==req.user.id)) return res.status(404).json({error:'Bestellung nicht gefunden'});
  db.prepare(`UPDATE orders SET status='shipped', tracking_number=?, carrier=? WHERE id=?`).run(trackingNumber||null,carrier||null,id);
  res.json({ok:true});
});

app.post('/api/orders',auth,(req,res)=>{
  const {productId}=req.body||{};
  const p=db.prepare(`SELECT * FROM products WHERE id=? AND status='active'`).get(productId);
  if(!p) return res.status(404).json({error:'Produkt nicht gefunden'});
  if(p.seller_id===req.user.id) return res.status(400).json({error:'Eigenes Produkt kann nicht gekauft werden'});
  const commission=Math.round(p.price_cents*.10);
  const order=db.transaction(()=>{
    const o=db.prepare('INSERT INTO orders(buyer_id,total_cents,commission_cents,seller_amount_cents) VALUES(?,?,?,?)').run(req.user.id,p.price_cents,commission,p.price_cents-commission);
    db.prepare('INSERT INTO order_items(order_id,product_id,seller_id,price_cents) VALUES(?,?,?,?)').run(o.lastInsertRowid,p.id,p.seller_id,p.price_cents);
    db.prepare("UPDATE products SET status='sold' WHERE id=?").run(p.id);
    return Number(o.lastInsertRowid);
  })();
  res.status(201).json({orderId:order,commissionCents:commission});
});

app.listen(PORT,()=>console.log(`ReVesti backend läuft auf http://localhost:${PORT}`));
