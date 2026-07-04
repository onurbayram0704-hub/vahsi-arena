/* ############################################################
   VAHŞİ ARENA — MULTIPLAYER SUNUCU (server.js)
   Oyunun "beyni" burasıdır: tüm fizik, yeme savaşı, dikenler
   ve power-up'lar sunucuda hesaplanır. Tarayıcılar sadece
   fare yönünü gönderir ve gelen dünyayı çizer.
   Çalıştırmak için: npm install && npm start
   ############################################################ */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const sunucu = http.createServer(app);
const io = new Server(sunucu);

// Oyun sayfasını da aynı sunucudan yayınlıyoruz (public klasörü)
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   1) AYARLAR — istemcideki değerlerle uyumlu tut
   ============================================================ */
const AYARLAR = {
  DUNYA: 6000,

  YEM_SAYISI: 900,
  YEM_KUTLE: 1.4,
  YEM_KAZANC: 0.1,       // Değişiklik: Yem başına kazanç 0.01 yapıldı

  BOT_SAYISI: 10,          // Arena boş kalmasın diye sunucu botları
  BOT_BASLANGIC: 25,

  BASLANGIC_KUTLE: 25,
  YEME_ORANI: 1.15,

  BOLUNME_MIN: 36,
  BIRLESME_SURESI: 12000,
  MAX_PARCA: 10,

  KUTLE_ATMA: 14,
  KUTLE_ATMA_MIN: 30,

  POWERUP_MAX: 14,
  POWERUP_SIKLIK: 3200,

  DIKEN_SAYISI: 10,
  DIKEN_YARICAP: 42,

  HIZ_KATSAYISI: 1,
  TICK_MS: 50,             // Sunucu saniyede 20 kez hesap yapar
};

const POWERUPLAR = [
  { id:'HIZ',     sure:6000 },
  { id:'KALKAN',  sure:8000 },
  { id:'MIKNATIS',sure:10000 },
  { id:'HAYALET', sure:7000 },
  { id:'DEV',     sure:0 },
  { id:'GOC',     sure:0 },
  { id:'BAL',     sure:10000 },
  { id:'BUZ',     sure:6000 },
];

/* ============================================================
   2) YARDIMCILAR
   ============================================================ */
const rnd = (a,b)=>a+Math.random()*(b-a);
const dist = (a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const sinirla = (v,min,max)=>Math.max(min,Math.min(max,v));
const yaricap = m => 4*Math.sqrt(m);

const BOT_ISIMLERI = ['Aslan','Kartal','Orka','Puma','Vaşak','Baykuş','Ahtapot',
  'Anakonda','Jaguar','Albatros','Kutup Ayısı','Yunus','Timsah','Panter'];
const BOT_RENKLERI = ['#C0846A','#7A9E7E','#B3A369','#6A8CAF','#9E7A8E',
  '#8A9A5B','#B87355','#6B8E9E'];

/* ============================================================
   3) OYUN DURUMU
   ============================================================ */
const oyuncular = new Map();   // socketId -> oyuncu
let yemler = [], poweruplar = [], dikenler = [], atilanKutleler = [], botlar = [];
let sonPowerupZamani = 0;

function yemOlustur(){
  return { x:rnd(0,AYARLAR.DUNYA), y:rnd(0,AYARLAR.DUNYA),
           r:rnd(4,6.5), c:Math.floor(rnd(0,10)) };  // c = renk indeksi
}
function powerupOlustur(){
  const tip = POWERUPLAR[Math.floor(rnd(0,POWERUPLAR.length))];
  return { x:rnd(200,AYARLAR.DUNYA-200), y:rnd(200,AYARLAR.DUNYA-200), id:tip.id };
}
function dikenOlustur(){
  return { x:rnd(300,AYARLAR.DUNYA-300), y:rnd(300,AYARLAR.DUNYA-300), r:AYARLAR.DIKEN_YARICAP };
}
function hucreOlustur(x,y,kutle){
  return { x, y, kutle, vx:0, vy:0, birlesme:0 };
}
function varlikOlustur(isim, renk, skin, bot){
  return {
    isim, renk, skin: skin||null, bot: !!bot,
    hucreler:[ hucreOlustur(rnd(500,AYARLAR.DUNYA-500), rnd(500,AYARLAR.DUNYA-500),
               bot ? AYARLAR.BOT_BASLANGIC+rnd(0,40) : AYARLAR.BASLANGIC_KUTLE) ],
    efektler:{}, hedef:{x:rnd(0,AYARLAR.DUNYA), y:rnd(0,AYARLAR.DUNYA)},
    kararZamani:0, enYuksek:AYARLAR.BASLANGIC_KUTLE
  };
}

for(let i=0;i<AYARLAR.YEM_SAYISI;i++)   yemler.push(yemOlustur());
for(let i=0;i<8;i++)                    poweruplar.push(powerupOlustur());
for(let i=0;i<AYARLAR.DIKEN_SAYISI;i++) dikenler.push(dikenOlustur());
for(let i=0;i<AYARLAR.BOT_SAYISI;i++){
  botlar.push(varlikOlustur(
    BOT_ISIMLERI[Math.floor(rnd(0,BOT_ISIMLERI.length))],
    BOT_RENKLERI[Math.floor(rnd(0,BOT_RENKLERI.length))], null, true));
}

const toplamKutle = v => v.hucreler.reduce((t,h)=>t+h.kutle,0);
const efektAktif = (v,id)=> v.efektler[id] && v.efektler[id] > Date.now();

/* ============================================================
   4) OYUN MEKANİKLERİ (tek oyunculu sürümle aynı mantık)
   ============================================================ */
function etkiUygula(varlik, id, socketId){
  const tip = POWERUPLAR.find(p=>p.id===id);
  if(!tip) return;
  if(tip.sure>0) varlik.efektler[id] = Date.now() + tip.sure;
  if(id==='DEV') varlik.hucreler.forEach(h=>h.kutle*=1.4);
  if(id==='GOC'){
    const nx=rnd(400,AYARLAR.DUNYA-400), ny=rnd(400,AYARLAR.DUNYA-400);
    const e=varlik.hucreler[0], fx=nx-e.x, fy=ny-e.y;
    varlik.hucreler.forEach(h=>{h.x+=fx; h.y+=fy;});
  }
  if(socketId) io.to(socketId).emit('powerupAldin', id);
}

function bolun(varlik, zorla){
  const yeni=[];
  for(const h of varlik.hucreler){
    if(varlik.hucreler.length+yeni.length >= AYARLAR.MAX_PARCA) break;
    if(!zorla && h.kutle < AYARLAR.BOLUNME_MIN) continue;
    h.kutle/=2;
    const d = Math.hypot(varlik.hedef.x-h.x, varlik.hedef.y-h.y)||1;
    const p = hucreOlustur(h.x,h.y,h.kutle);
    p.vx=(varlik.hedef.x-h.x)/d*22*3; p.vy=(varlik.hedef.y-h.y)/d*22*3;
    p.birlesme = h.birlesme = Date.now()+AYARLAR.BIRLESME_SURESI;
    yeni.push(p);
  }
  varlik.hucreler.push(...yeni);
}

function kutleAt(varlik){
  for(const h of varlik.hucreler){
    if(h.kutle < AYARLAR.KUTLE_ATMA_MIN) continue;
    h.kutle -= AYARLAR.KUTLE_ATMA;
    const d = Math.hypot(varlik.hedef.x-h.x, varlik.hedef.y-h.y)||1;
    const yx=(varlik.hedef.x-h.x)/d, yy=(varlik.hedef.y-h.y)/d;
    const r=yaricap(h.kutle);
    atilanKutleler.push({ x:h.x+yx*(r+12), y:h.y+yy*(r+12),
      vx:yx*16*3, vy:yy*16*3, kutle:AYARLAR.KUTLE_ATMA*0.85, renk:varlik.renk });
  }
}

function dikenPatlat(varlik, hucre){
  const simdi = Date.now();
  hucre.kutle *= 0.88;
  const bosYer = AYARLAR.MAX_PARCA - varlik.hucreler.length;
  const parcaSayisi = Math.min(bosYer+1, 6);
  if(parcaSayisi>1){
    const pk = hucre.kutle/parcaSayisi;
    hucre.kutle = pk;
    hucre.birlesme = simdi+AYARLAR.BIRLESME_SURESI;
    for(let i=1;i<parcaSayisi;i++){
      const a=rnd(0,Math.PI*2);
      const p=hucreOlustur(hucre.x,hucre.y,pk);
      p.vx=Math.cos(a)*18*3; p.vy=Math.sin(a)*18*3;
      p.birlesme=simdi+AYARLAR.BIRLESME_SURESI;
      varlik.hucreler.push(p);
    }
  }
}

function donmaCarpani(varlik, herkes){
  for(const o of herkes){
    if(o===varlik || !o.hucreler.length || !efektAktif(o,'BUZ')) continue;
    for(const oh of o.hucreler)
      for(const h of varlik.hucreler)
        if(dist(oh,h)<500) return 0.5;
  }
  return 1;
}

function varligiGuncelle(varlik, socketId, herkes){
  const simdi = Date.now();
  let carpan = donmaCarpani(varlik, herkes);
  if(efektAktif(varlik,'HIZ'))     carpan*=1.8;
  if(efektAktif(varlik,'HAYALET')) carpan*=1.15;

  for(const h of varlik.hucreler){
    const d = Math.hypot(varlik.hedef.x-h.x, varlik.hedef.y-h.y)||1;
    const yx=(varlik.hedef.x-h.x)/d, yy=(varlik.hedef.y-h.y)/d;
    // Tick 20/sn olduğu için hız 60fps'e göre 3 kat (12 -> 36)
    const hiz = AYARLAR.HIZ_KATSAYISI * carpan * Math.pow(h.kutle,-0.22) * 36;
    h.vx += (yx*hiz - h.vx)*0.35;
    h.vy += (yy*hiz - h.vy)*0.35;
    h.x += h.vx; h.y += h.vy;
    const r = yaricap(h.kutle);
    h.x = sinirla(h.x, r, AYARLAR.DUNYA-r);
    h.y = sinirla(h.y, r, AYARLAR.DUNYA-r);
  }

  // Kendi parçaları: birleşme / itişme
  for(let i=0;i<varlik.hucreler.length;i++){
    for(let j=i+1;j<varlik.hucreler.length;j++){
      const a=varlik.hucreler[i], b=varlik.hucreler[j];
      const d=dist(a,b), ra=yaricap(a.kutle), rb=yaricap(b.kutle);
      const olur = simdi>a.birlesme && simdi>b.birlesme;
      if(olur && d<Math.max(ra,rb)*0.6){
        a.kutle+=b.kutle; varlik.hucreler.splice(j,1); j--;
      }else if(!olur && d<ra+rb && d>0){
        const it=(ra+rb-d)/d*0.5;
        const dx=(b.x-a.x)*it, dy=(b.y-a.y)*it;
        a.x-=dx;a.y-=dy;b.x+=dx;b.y+=dy;
      }
    }
  }

  const miknatis = efektAktif(varlik,'MIKNATIS');
  const bal = efektAktif(varlik,'BAL');

  for(const h of varlik.hucreler){
    const r = yaricap(h.kutle);

    // Yemler
    for(let i=0;i<yemler.length;i++){
      const y=yemler[i], d=dist(h,y);
      if(miknatis && d<r+220){
        y.x+=(h.x-y.x)*0.24; y.y+=(h.y-y.y)*0.24;
        io.emit('yem', {i, y});                 // Çekilen yem herkeste güncellensin
      }
      if(d<r){
        const kat = bal?2:1;
        h.kutle += AYARLAR.YEM_KUTLE*kat;
        if(socketId) io.to(socketId).emit('kazanc', AYARLAR.YEM_KAZANC*kat);
        yemler[i]=yemOlustur();
        io.emit('yem', {i, y:yemler[i]});
      }
    }
    // Atılan kütleler
    for(let i=atilanKutleler.length-1;i>=0;i--){
      if(dist(h,atilanKutleler[i])<r){
        h.kutle+=atilanKutleler[i].kutle;
        atilanKutleler.splice(i,1);
      }
    }
    // Power-up'lar
    for(let i=poweruplar.length-1;i>=0;i--){
      if(dist(h,poweruplar[i])<r+18){
        etkiUygula(varlik, poweruplar[i].id, socketId);
        poweruplar.splice(i,1);
      }
    }
    // Dikenler
    if(!efektAktif(varlik,'KALKAN')){
      for(let i=0;i<dikenler.length;i++){
        const dk=dikenler[i];
        if(r>dk.r*1.1 && dist(h,dk)<r*0.8){
          dikenPatlat(varlik,h);
          dikenler[i]=dikenOlustur();
          io.emit('diken', {i, d:dikenler[i]});
          break;
        }
      }
    }
  }
}

function yemeKontrolu(avci, av){
  if(efektAktif(av,'KALKAN')||efektAktif(av,'HAYALET')||efektAktif(avci,'HAYALET')) return;
  for(const ah of avci.hucreler){
    const ar=yaricap(ah.kutle);
    for(let i=av.hucreler.length-1;i>=0;i--){
      const vh=av.hucreler[i];
      if(ah.kutle>vh.kutle*AYARLAR.YEME_ORANI &&
         dist(ah,vh)<ar-yaricap(vh.kutle)*0.4){
        ah.kutle+=vh.kutle;
        av.hucreler.splice(i,1);
      }
    }
  }
}

function botKarar(bot, herkes){
  const simdi=Date.now();
  if(simdi<bot.kararZamani) return;
  bot.kararZamani=simdi+rnd(400,900);
  const bh=bot.hucreler[0]; if(!bh) return;
  const benim=toplamKutle(bot), br=yaricap(bh.kutle);
  const rakipler=herkes.filter(v=>v!==bot && v.hucreler.length);

  for(const dk of dikenler){
    if(br>dk.r*1.1 && dist(bh,dk)<260){
      bot.hedef={x:bh.x+(bh.x-dk.x)*3, y:bh.y+(bh.y-dk.y)*3}; return;
    }
  }
  let tehdit=null, tm=520;
  for(const r of rakipler) for(const h of r.hucreler){
    const d=dist(bh,h);
    if(h.kutle>benim*AYARLAR.YEME_ORANI && d<tm){tehdit=h;tm=d;}
  }
  if(tehdit){ bot.hedef={x:bh.x+(bh.x-tehdit.x)*3, y:bh.y+(bh.y-tehdit.y)*3}; return; }

  let av=null, am=650;
  for(const r of rakipler){
    if(efektAktif(r,'KALKAN')||efektAktif(r,'HAYALET')) continue;
    for(const h of r.hucreler){
      const d=dist(bh,h);
      if(benim>h.kutle*AYARLAR.YEME_ORANI*1.1 && d<am){av=h;am=d;}
    }
  }
  if(av){ bot.hedef={x:av.x,y:av.y}; return; }

  let hedef=null, m=900;
  for(const p of poweruplar){ const d=dist(bh,p); if(d<m){m=d;hedef=p;} }
  if(!hedef){
    m=1e9;
    for(let i=0;i<yemler.length;i+=7){
      const d=dist(bh,yemler[i]); if(d<m){m=d;hedef=yemler[i];}
    }
  }
  if(hedef) bot.hedef={x:hedef.x,y:hedef.y};
}

/* ============================================================
   5) BAĞLANTI YÖNETİMİ
   ============================================================ */
io.on('connection', socket => {
  console.log('Bağlandı:', socket.id);

  socket.on('katil', veri => {
    const isim = String(veri.isim||'İsimsiz').slice(0,14);
    const skin = veri.skin ? String(veri.skin).slice(0,20) : null;
    oyuncular.set(socket.id, varlikOlustur(isim, '#1AD152', skin));
    // Yeni oyuncuya dünyanın anlık fotoğrafını gönder
    socket.emit('baslangic', {
      id: socket.id,
      dunya: AYARLAR.DUNYA,
      yemler, dikenler
    });
  });

  socket.on('hedef', h => {
    const o = oyuncular.get(socket.id);
    if(o && typeof h.x==='number' && typeof h.y==='number'){
      o.hedef.x = sinirla(h.x, 0, AYARLAR.DUNYA);
      o.hedef.y = sinirla(h.y, 0, AYARLAR.DUNYA);
    }
  });
  socket.on('bolun', ()=>{ const o=oyuncular.get(socket.id); if(o) bolun(o); });
  socket.on('kutleAt', ()=>{ const o=oyuncular.get(socket.id); if(o) kutleAt(o); });
  socket.on('skinDegistir', s=>{
    const o=oyuncular.get(socket.id);
    if(o) o.skin = s ? String(s).slice(0,20) : null;
  });
  socket.on('disconnect', ()=>{
    oyuncular.delete(socket.id);
    console.log('Ayrıldı:', socket.id);
  });
});

/* ============================================================
   6) ANA DÖNGÜ — saniyede 20 kez
   ============================================================ */
setInterval(()=>{
  const simdi = Date.now();

  if(simdi-sonPowerupZamani > AYARLAR.POWERUP_SIKLIK &&
     poweruplar.length < AYARLAR.POWERUP_MAX){
    poweruplar.push(powerupOlustur());
    sonPowerupZamani = simdi;
  }
  for(const k of atilanKutleler){ k.x+=k.vx; k.y+=k.vy; k.vx*=0.85; k.vy*=0.85; }

  const herkes = [...oyuncular.values(), ...botlar];

  for(const [sid, o] of oyuncular) varligiGuncelle(o, sid, herkes);
  for(const b of botlar){ botKarar(b, herkes); varligiGuncelle(b, null, herkes); }

  for(const a of herkes) for(const b of herkes)
    if(a!==b && a.hucreler.length && b.hucreler.length) yemeKontrolu(a,b);

  // Ölen botlar yeniden doğar
  for(let i=0;i<botlar.length;i++){
    if(!botlar[i].hucreler.length){
      botlar[i]=varlikOlustur(
        BOT_ISIMLERI[Math.floor(rnd(0,BOT_ISIMLERI.length))],
        BOT_RENKLERI[Math.floor(rnd(0,BOT_RENKLERI.length))], null, true);
    }
  }
  // Ölen oyunculara haber ver
  for(const [sid,o] of oyuncular){
    if(o.hucreler.length){
      o.enYuksek = Math.max(o.enYuksek, toplamKutle(o));
    }else{
      // Değişiklik: Oyun sonu ulaşılan en yüksek kütle skor olarak ve kazanç/altın olarak gönderiliyor
      const sonSkor = Math.floor(o.enYuksek);
      io.to(sid).emit('oldun', { skor: sonSkor, kazanc: sonSkor });
      oyuncular.delete(sid);
    }
  }

  // Herkese dünya durumu (yemler hariç — onlar olay bazlı gidiyor)
  const durum = {
    oyuncular: [...oyuncular.entries()].map(([sid,o])=>paketle(sid,o))
               .concat(botlar.filter(b=>b.hucreler.length)
               .map((b,i)=>paketle('bot'+i,b))),
    poweruplar,
    atilan: atilanKutleler.map(k=>({x:Math.round(k.x),y:Math.round(k.y),
                                     kutle:k.kutle,renk:k.renk}))
  };
  io.emit('durum', durum);
}, AYARLAR.TICK_MS);

function paketle(id, o){
  const simdi = Date.now();
  const efekt = {};
  for(const k in o.efektler)
    if(o.efektler[k]>simdi) efekt[k]=o.efektler[k]-simdi;
  return {
    id, isim:o.isim, renk:o.renk, skin:o.skin, efekt,
    h: o.hucreler.map(c=>({x:Math.round(c.x), y:Math.round(c.y),
                            k:Math.round(c.kutle*10)/10}))
  };
}

const PORT = process.env.PORT || 3000;
sunucu.listen(PORT, ()=>console.log(`🌿 Vahşi Arena sunucusu ${PORT} portunda!`));
