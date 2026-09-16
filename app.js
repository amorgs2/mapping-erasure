
//colors for rendering
const BLUE   = '#2D7DE1';
const CORAL  = '#F0532A';
const AMBER  = '#F5A81B';
const GRAY   = '#8A8175';
const ACCENT = '#A03030';
const BASE   = '#24476B';
const EXTANT = '#B3AA97';
const EXTANT_FILL = '#E4DED0';
const UNKNOWN = '#5A6B7C';
const GHOST   = '#4A4338';

const certC = {High:'#1F6F6B', Medium:'#3E9B5F', Low:'#9CCB3B'};
const denC = {High:'#3A1C9E', Medium:'#D6336C', Low:'#F6C343', None:null};


function certOf(p){
  return certC[p.spatial_certainty] || certC.Low;
}


function erColor(t){
  if(t.startsWith('Submerged')) return BLUE;
  if(t.startsWith('Depopulated')) return CORAL;
  if(t.startsWith('Relocated')) return AMBER;
  if(t.startsWith('Persists')) return EXTANT;
  return UNKNOWN;
}


// was it standing in year x?
function stoodIn(p,y){
  if(y==null || p.start_year==null) return false;
  const openEnd = String(p.erasure_type).startsWith('Persists');
  if(p.end_year==null && !openEnd) return false;
  return y>=p.start_year && y<=(p.end_year ?? 9999);
}


function claimsOf(p){
  return p.geometry_claims || [];
}


// export.py flags this when the claims miss each other
function isCandidates(p){
  return !!p.sources_disagree;
}


function statedRadius(p){
  const r = p.uncertainty_radius_m;
  if(typeof r === 'number' && r > 0) return r;
  return null;
}


function isArea(p){
  return !isCandidates(p) && statedRadius(p) !== null;
}


function isStriped(p){
  return p.spatial_certainty==='Low' || p.spatial_certainty==='Unknown' || p.spatial_certainty==='Disputed';
}


function extentUnrecorded(p){
  return !isCandidates(p) && statedRadius(p)===null && isStriped(p);
}


const presentDayTone = () => mode==='atlas' || mode==='displacement';


function modeColor(p){
  if(usbOn && usBuilt(p)) return ACCENT;
  if(mode==='reconstruction') return certOf(p);
  if(mode==='density') return denC[p.archival_visibility] || GRAY;
  if(mode==='displacement') return erColor(p.erasure_type);
  return BASE;
}


const HOME_LL = [9.10,-79.74];
const HOME_Z = 11;
const map = L.map('map',{scrollWheelZoom:true}).setView(HOME_LL,HOME_Z);


// map camvas
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  {attribution:'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ', maxNativeZoom:16, maxZoom:19}).addTo(map);

map.createPane('todayPane');
map.getPane('todayPane').style.zIndex = 350;
const todayRenderer = L.svg({pane:'todayPane'});


// diagonal stripes for the uncertain areas
function ensureHatch(){
  const svg = document.querySelector('.leaflet-overlay-pane svg');
  if(!svg) return;
  if(svg.querySelector('#hatch')) return;
  const NS = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(NS,'defs');
  const pat = document.createElementNS(NS,'pattern');
  pat.setAttribute('id','hatch');
  pat.setAttribute('width','7');
  pat.setAttribute('height','7');
  pat.setAttribute('patternUnits','userSpaceOnUse');
  pat.setAttribute('patternTransform','rotate(45)');
  const ln = document.createElementNS(NS,'line');
  ln.setAttribute('x1','0');
  ln.setAttribute('y1','0');
  ln.setAttribute('x2','0');
  ln.setAttribute('y2','7');
  ln.setAttribute('stroke','#555');
  ln.setAttribute('stroke-width','3');
  ln.setAttribute('stroke-opacity','0.55');
  pat.appendChild(ln);
  defs.appendChild(pat);
  svg.insertBefore(defs, svg.firstChild);
}


let markers = {};
let feats = [];
let allRecords = [];
let propsById = {};
let kidsOf = {};
let idByName = {};
let searchText = {};
let q = '';
let footprints = {};
let sourcesMeta = [];
let relations = [];
let meta = null;
let archivesMeta = [];
let eyeSrc = null;
let eyeLayer = null;
const relLayer = L.layerGroup().addTo(map);


let mode = 'atlas';
let year = 1900;
let ghostsOn = true;
let allTime = true;
let usbOn = false;
let selId = null;
const filt = {scale:'', dens:'', abs:'', eras:'', disagree:false};


const US_BUILT = new Set(['Gold Roll town','West Indian / Silver Roll']);
function usBuilt(p){
  return US_BUILT.has(p.population_type);
}

// the sources spell Matachin/Matachín and Pena/Peña interchangeably
function fold(s){
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
}

// no-cache so the browser revalidates. The data files are rewritten on every export
// and carry no version string in the URL, so a plain fetch can sit on a stale model.
function getJSON(u){
  return fetch(u,{cache:'no-cache'}).then(r=>r.json());
}

Promise.all([
  getJSON('data/places.geojson'),
  getJSON('data/records.json'),
  getJSON('data/sources.json'),
  getJSON('data/relations.json'),
  getJSON('data/meta.json'),
  getJSON('data/footprints.geojson'),
  getJSON('data/archives.json').catch(()=>[])   // older exports have no archives file
]).then(([geo,records,srcs,rels,mt,fps,archs])=>{
  feats = geo.features;
  allRecords = records;
  sourcesMeta = srcs;
  relations = rels;
  meta = mt;
  archivesMeta = archs;

  // Gorgona has footprints from 1895, 1905-06 and 1908.
  (fps.features||[]).forEach(f=>{
    const id = f.properties.place_id;
    if(!footprints[id]) footprints[id] = {type:'FeatureCollection', features:[]};
    footprints[id].features.push(f);
  });

  feats.forEach(f=>{
    const p = f.properties;
    const lng = f.geometry.coordinates[0];
    const lat = f.geometry.coordinates[1];
    const base = {};
    if(p.extant){
      base.pane = 'todayPane';
      base.renderer = todayRenderer;
    }
    let m;
    if(isCandidates(p)){
      const pts = claimsOf(p).map(c=>[c.lat,c.lng]);
      const tie = L.polyline(pts,{...base});
      const parts = [tie].concat(pts.map(ll=>L.circleMarker(ll,{radius:5,...base})));

      let unc = null;
      if(footprints[p.id]) unc = L.geoJSON(footprints[p.id],{style:()=>({...base})});
      else if(statedRadius(p)) unc = L.circle([lat,lng],{radius:statedRadius(p),...base});
      if(unc) parts.unshift(unc);
      m = L.featureGroup(parts);
      m._kind = 'candidates';
      m._unc = unc;
    } else if(footprints[p.id]){
      m = L.geoJSON(footprints[p.id],{style:()=>({...base})});
      m._kind = 'footprint';
    } else if(isArea(p)){
      m = L.circle([lat,lng],{radius:statedRadius(p),...base});
      m._kind = 'area';
    } else if(extentUnrecorded(p)){
      m = L.circleMarker([lat,lng],{radius:10,...base});
      m._kind = 'unrecorded';
    } else {
      m = L.circleMarker([lat,lng],{radius:6,...base});
      m._kind = 'point';
    }
    m.addTo(map);

    m.on('click',e=>{
      L.DomEvent.stopPropagation(e.originalEvent);
      selectPlace(p.id);
    });
    m._area = (m._kind==='area' || m._kind==='footprint');
    m._striped = isStriped(p);
    markers[p.id] = m;
    propsById[p.id] = p;
  });
  ensureHatch();


  allRecords.forEach(r=>{
    if(!nested(r)) return;
    if(!kidsOf[r.parent]) kidsOf[r.parent] = [];
    kidsOf[r.parent].push(r);
  });
  Object.values(kidsOf).forEach(l=>{
    l.sort((a,b)=>a.scale.localeCompare(b.scale) || a.name.localeCompare(b.name));
  });
  allRecords.forEach(r=>{
    if(r.scale==='Town') idByName[r.name] = r.id;
  });

  //name findable even if old
  allRecords.forEach(r=>{
    const names = new Set([r.name]);
    (r.evidence||[]).forEach(a=>{
      const n = (a.name||'').trim();
      if(n && !n.startsWith('(')) names.add(n);   // "(PI-91 place index)" is a harvest note
    });
    searchText[r.id] = fold([...names].join(' '));
  });

  buildFilterOptions(records);
  buildSrcList();
  buildRelLayer();
  buildArchives();
  const eye = readHash();
  applyState();
  renderUnloc();
  renderLoc();
  setLegend();
  showYear();
  render();
  if(eye) enterEye(eye);
}).catch(err=>{
  const el = document.getElementById('desc');
  if(el) el.textContent = 'The data failed to load ('+err.message+'). Reload the page; if the panels remain empty, force a full refresh (Cmd+Shift+R).';
  console.error(err);
});


function uniq(a){
  return [...new Set(a.filter(Boolean))].sort();
}


function buildFilterOptions(records){
  const OPT_LABEL = {
    'Depopulated-not flooded':'Depopulated, not flooded',
    'Persists':'Persists (never removed)'
  };
  const OPT_ORDER = {
    fDens:['High','Medium','Low'],
    fEras:['Submerged','Depopulated-not flooded','Relocated','Persists','Unknown']
  };
  function add(id,vals){
    const sel = document.getElementById(id);
    const ord = OPT_ORDER[id] || [];
    function rank(v){
      const i = ord.indexOf(v);
      return i<0 ? ord.length : i;
    }
    [...vals].sort((a,b)=>rank(a)-rank(b) || a.localeCompare(b)).forEach(v=>{
      const o = document.createElement('option');
      o.value = v;
      o.textContent = OPT_LABEL[v] || v;
      sel.appendChild(o);
    });
  }

  const nFeat = feats.filter(f=>nested(f.properties)).length;
  document.querySelectorAll('#scaleswitch .scbtn').forEach(b=>{
    const n = (b.dataset.scale==='features') ? nFeat : feats.length-nFeat;
    b.textContent += ` (${n})`;
  });

  add('fDens', uniq(records.map(r=>r.archival_visibility)));
  add('fEras', uniq(records.map(r=>r.erasure_type)));

  const fa = document.getElementById('fAbs');
  const absOpts = [
    ['while','left out by a source made in its lifetime'],
    ['never','never left out in its lifetime']
  ];
  absOpts.forEach(([v,t])=>{
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    fa.appendChild(o);
  });
}


const SCALE_VIEWZ = {'Neighborhood':14, 'Site/Institution':14, 'Building':15, 'Infrastructure':15};


function nested(p){
  return !!p.parent && p.scale!=='Town';
}


function passes(p){
  if(filt.scale==='features'){
    if(!nested(p)) return false;
  } else if(nested(p)){
    return false;
  }
  if(filt.dens && p.archival_visibility!==filt.dens) return false;
  if(filt.abs==='while' && !p.lifespan_absent) return false;
  if(filt.abs==='never' && p.lifespan_absent) return false;
  if(filt.eras && p.erasure_type!==filt.eras) return false;
  if(filt.disagree && !p.sources_disagree) return false;
  return true;
}


function liveOpacity(Y,p){
  const s = p.start_year;
  const e = p.end_year;
  if(s!=null && Y<s) return 0;
  if(e!=null && Y>e) return 0;
  const as = p.attested_start;
  const ae = (p.attested_end==null) ? p.attested_start : p.attested_end;
  if(as!=null && Y>=as && Y<=ae) return 1;
  return 0.55;
}


function ghostOp(Y,e,on){
  if(!on || e==null) return 0;
  return (Y>e) ? 0.6 : 0;
}


function locDotCSS(p){
  function ring(c){
    return `background:transparent; box-shadow:inset 0 0 0 2px ${c}`;
  }
  if(p.extant && presentDayTone()){
    const ec = (usbOn&&usBuilt(p)) ? ACCENT : EXTANT;
    return `background:${EXTANT_FILL}; box-shadow:inset 0 0 0 2px ${ec}`;
  }
  const lo = allTime ? 1 : liveOpacity(year,p);
  const go = allTime ? 0 : ghostOp(year,p.end_year,ghostsOn);
  if(lo<0.04){
    if(go>=0.04) return ring(GHOST);
    return ring('rgba(19,49,75,0.25)');
  }
  // density draws its no-sources class hollow, so the dot goes hollow too
  if(mode==='density' && !(usbOn&&usBuilt(p)) && !denC[p.archival_visibility]) return ring(GRAY);
  return `background:${modeColor(p)}; opacity:${lo<1?0.55:1}`;
}


function pointStyle(p){
  if(usbOn && usBuilt(p)){
    return {radius:6, color:ACCENT, fillColor:ACCENT, fillOpacity:0.9, weight:0};
  }
  if(mode==='density'){
    const c = denC[p.archival_visibility];
    if(!c) return {radius:5, color:GRAY, fillOpacity:0, weight:2, dashArray:'2 2'};
    const big = (p.archival_visibility==='Medium' || p.archival_visibility==='High');
    return {radius:big?9:6, color:c, fillColor:c, fillOpacity:0.9, weight:0};
  }
  if(mode==='displacement'){
    const c = erColor(p.erasure_type);
    return {radius:6, color:c, fillColor:c, fillOpacity:0.9, weight:0};
  }
  if(mode==='reconstruction'){
    const c = certOf(p);
    return {radius:5, color:c, fillColor:c, fillOpacity:0.9, weight:0};
  }
  return {radius:5, color:BASE, fillColor:BASE, fillOpacity:0.9, weight:0};
}


function setFill(m,val,op){
  if(m._path){
    m._path.setAttribute('fill',val);
    m._path.setAttribute('fill-opacity',op);
    return;
  }
  if(m.eachLayer) m.eachLayer(l=>{
    if(l._path){
      l._path.setAttribute('fill',val);
      l._path.setAttribute('fill-opacity',op);
    }
  });
}


function setClickable(m,on){
  function f(l){
    if(l._path) l._path.style.pointerEvents = on ? '' : 'none';
  }
  f(m);
  if(m.eachLayer) m.eachLayer(f);
}


function hide(m){
  m.setStyle({opacity:0,fillOpacity:0});
  if(m._path) m._path.setAttribute('fill-opacity',0);
  setClickable(m,false);
}


function render(){
  if(eyeSrc) return;            
  ensureHatch();
  epilogue();

  feats.forEach(f=>{
    const p = f.properties;
    const m = markers[p.id];
    if(!passes(p)){ hide(m); return; }

    if(p.extant && presentDayTone()){
      const on = allTime || (p.start_year==null || year>=p.start_year);
      const o = on ? 0.85 : 0;
     
      const ec = (usbOn&&usBuilt(p)) ? ACCENT : EXTANT;
      if(m._area){
        m.setStyle({color:ec, weight:2, fillColor:EXTANT_FILL, fillOpacity:on?0.5:0, opacity:o, dashArray:''});
      } else {
        m.setStyle({radius:6, color:ec, fillColor:EXTANT_FILL, weight:2, fillOpacity:on?0.6:0, opacity:o, dashArray:''});
      }
      setClickable(m,on);
      return;
    }

    const lo = allTime ? 1 : liveOpacity(year,p);
    const go = allTime ? 0 : ghostOp(year,p.end_year,ghostsOn);
    if(lo<0.04 && go<0.04){ hide(m); return; }
    setClickable(m,true);

    if(lo<0.04){
      
      m.setStyle({color:GHOST, weight:2, dashArray:'0.1 6', lineCap:'round', opacity:go, fillOpacity:0});
      if(m._area) setFill(m,'none',0);
      if(m._unc) setFill(m._unc,'none',0);
      return;
    }

    const col = modeColor(p);
    if(m._kind==='candidates'){
      m.setStyle({color:col, weight:2.5, opacity:0.95*lo, fillColor:'#fff', fillOpacity:0.85*lo, dashArray:''});
      if(m._unc){
        m._unc.setStyle({color:col, weight:2, opacity:0.9*lo, fillOpacity:0, dashArray:''});
        if(m._striped) setFill(m._unc,'url(#hatch)',(0.85*lo).toFixed(2));
        else setFill(m._unc,col,(0.22*lo).toFixed(2));
      }
    } else if(m._kind==='unrecorded'){
      m.setStyle({color:col, weight:2, opacity:0.9*lo, fillOpacity:0, dashArray:'2 3'});
      setFill(m,'url(#hatch)',(0.45*lo).toFixed(2));
    } else if(m._area){
      m.setStyle({color:col, weight:2, opacity:0.9*lo, fillOpacity:0, dashArray:''});
      if(m._striped) setFill(m,'url(#hatch)',(0.85*lo).toFixed(2));
      else setFill(m,col,(0.22*lo).toFixed(2));
    } else {
      const st = pointStyle(p);
      m.setStyle({...st, opacity:lo, fillOpacity:(st.fillOpacity||0)*lo});
    }
  });

  
  relLayer.eachLayer(h=>{
    const ap = propsById[h._anchorId];
    let anchorOn = false;
    if(ap && passes(ap)){
      if(allTime) anchorOn = true;
      else if(ap.extant) anchorOn = (ap.start_year==null || year>=ap.start_year);
      else anchorOn = liveOpacity(year,ap)>=0.04 || ghostOp(year,ap.end_year,ghostsOn)>=0.04;
    }
    const on = anchorOn && (allTime || liveOpacity(year,h._lostRec)>=0.04);
    h.setStyle({opacity:on?0.8:0});
    if(h._path) h._path.style.pointerEvents = on ? '' : 'none';
  });

  document.querySelectorAll('#unloc .uitem').forEach(el=>{
    const show = el.dataset.match==='1' && matchesQ(el.dataset.id);
    el.style.display = show ? 'block' : 'none';
    el.style.opacity = (!allTime && year > +el.dataset.end) ? 0.45 : 1;
  });
  document.querySelectorAll('#loclist .uitem').forEach(el=>{
    const p = propsById[el.dataset.id];
    if(!p) return;
    const dot = el.querySelector('.dot-abs');
    if(dot) dot.style.cssText = locDotCSS(p);
    el.style.display = (passes(p) && matchesQ(p.id)) ? 'block' : 'none';
    el.style.opacity = (!allTime && p.end_year && year>p.end_year) ? 0.45 : 1;
  });

  const sp = selId && propsById[selId];
  if(sp && passes(sp)){
    const sm = markers[selId];
    sm.setStyle({color:ACCENT, weight:3});
    if(sm._kind==='point' && !sp.extant) sm.setStyle({fillColor:ACCENT});
  }

  if(!recPop.hidden && recPop._id){
    const st = recPop.scrollTop;
    showRec(recPop._id);
    recPop.scrollTop = st;
  }
}


function nameOf(id){
  const r = allRecords.find(x=>x.id===id);
  return r ? r.name : id;
}


function relationsOf(id){
  return relations.filter(r=>r.from===id || r.to===id);
}


function relText(r,selfId){
  const fromSelf = (r.from===selfId);
  const other = nameOf(fromSelf ? r.to : r.from);
  const phr = {
    part_of:[`part of ${other}`, `contains ${other}`],
    replaced_by:[`replaced by ${other}`, `replaced ${other}`],
    near:[`near ${other}`, `near ${other}`]
  }[r.type] || [`${r.type} ${other}`, `${r.type} ${other}`];
  return fromSelf ? phr[0] : phr[1];
}


function buildRelLayer(){
  relLayer.clearLayers();
  const locIdx = {};
  feats.forEach(f=>{
    locIdx[f.properties.id] = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
  });
  const stack = {};          // count per anchor, so several halos can nest
  relations.forEach(r=>{
    [[r.from,r.to],[r.to,r.from]].forEach(([lost,anchor])=>{
      if(locIdx[lost] || !locIdx[anchor]) return;
      const rec = allRecords.find(x=>x.id===lost);
      if(!rec) return;
      stack[anchor] = (stack[anchor]||0) + 1;
      const halo = L.circleMarker(locIdx[anchor],{
        radius:16+10*stack[anchor], color:GRAY, weight:2,
        dashArray:'5 5', fillOpacity:0, opacity:0.8, interactive:true});
      halo._anchorId = anchor;
      halo._lostRec = rec;
      const kind = (r.type||'').replace('_',' ');
      halo.bindTooltip(`${rec.name} — recorded as "${kind}" ${nameOf(anchor)}, but never located itself`);
      relLayer.addLayer(halo);
    });
  });
}


function archTrail(arr){
  const m = new Map();
  arr.forEach(e=>{
    const s = (e.source||'').replace(/\s*\(.*$/,'').trim();
    const y = e.year || null;
    if(!m.has(s)){ m.set(s,y); return; }
    const prev = m.get(s);
    if(y && (!prev || y<prev)) m.set(s,y);
  });
  return [...m.entries()];
}


function yrSpan(ev){
  const ys = ev.map(e=>e.year).filter(Boolean).sort((a,b)=>a-b);
  if(!ys.length) return '';
  const first = ys[0];
  const last = ys[ys.length-1];
  return (first===last) ? `${first}` : `${first}–${last}`;
}


function renderUnloc(){
  const located = new Set(feats.map(f=>f.properties.id));
  let unl = allRecords.filter(r=>!located.has(r.id));
  // TEMPORARY hide places named by fewer than 2 distinct archives.
  unl = unl.filter(r=>archTrail(r.evidence||[]).length>=2);
  unl.sort((a,b)=>((b.traces||0)+(b.negative_traces||0)) - ((a.traces||0)+(a.negative_traces||0)));
  document.getElementById('unloc').innerHTML = unl.map(u=>{
    const nH = archTrail(u.evidence||[]).length;
    const nM = archTrail(u.neg_evidence||[]).length;
    const span = yrSpan(u.evidence||[]);
   
    const bits = [];
    if(nH) bits.push(`<span class="ub ub-h">named in ${nH}</span>`);
    if(span) bits.push(`<span class="uyr">${span}</span>`);
    if(nM) bits.push(`<span class="ub ub-m">searched, absent in ${nM}</span>`);
    const anch = relations.find(r=>(r.from===u.id&&located.has(r.to)) || (r.to===u.id&&located.has(r.from)));
    if(anch){
      const other = (anch.from===u.id) ? anch.to : anch.from;
      bits.push(`<span class="ub ub-a">near ${nameOf(other)}</span>`);
    }
    return `<div class="uitem uD12" data-id="${u.id}" data-end="${u.end_year||9999}" data-match="${passes(u)?1:0}">
      <div class="un-head"><span class="dot-abs dot-unloc"></span><span class="un-name">${u.name}</span></div>
      <div class="un-bits">${bits.join('')}</div></div>`;
  }).join('');
}


let locSort = 'date';

function renderLoc(){
  const rows = feats.map(f=>f.properties);
  if(locSort==='alpha'){
    rows.sort((a,b)=>a.name.localeCompare(b.name));
  } else {
    rows.sort((a,b)=>((a.start_year??a.attested_start)??9999) - ((b.start_year??b.attested_start)??9999));
  }
  document.getElementById('loclist').innerHTML = rows.map(p=>{
    const kids = (kidsOf[p.name] && p.scale==='Town') ? kidsOf[p.name].length : 0;
    const bits = [
      `<span class="uyr">~${p.start_year||'?'}–${p.end_year||'persists'}</span>`,
      `<span class="uyr">${p.scale||p.place_type}</span>`,
      `<span class="ub ub-h">${p.n_sources} source${p.n_sources!==1?'s':''}</span>`
    ];
    if(p.lifespan_absent) bits.push(`<span class="ub ub-m">left out by ${p.lifespan_absent} in its lifetime</span>`);
    if(kids) bits.push(`<span class="ub ub-a">${kids} feature${kids!==1?'s':''} within</span>`);
    return `<div class="uitem" data-id="${p.id}">
      <div class="un-head"><span class="dot-abs" style="${locDotCSS(p)}"></span><span class="un-name">${p.name}</span></div>
      <div class="un-bits">${bits.join('')}</div></div>`;
  }).join('');
}


document.querySelectorAll('#locsort .sortbtn').forEach(b=>b.addEventListener('click',()=>{
  if(locSort===b.dataset.mode) return;
  locSort = b.dataset.mode;
  document.querySelectorAll('#locsort .sortbtn').forEach(x=>x.classList.toggle('on',x===b));
  const tail = (locSort==='alpha') ? 'alphabetically by name' : 'from oldest founding to youngest';
  document.getElementById('locsub').textContent =
    'places with coordinates, plotted at the selected scale, ordered ' + tail +
    '; select one to open its record on the map';
  renderLoc();
  render();
}));


function openPlace(id){
  if(eyeSrc) exitEye();
  const p = propsById[id];
  if(!p){ showRec(id); return; } 
  if(!passes(p)){
    filt.scale = nested(p) ? 'features' : '';
    setScaleUI();
    renderUnloc();
    render();
    writeHash();
  }
  const m = markers[id];
  if(!m) return;
  const f = feats.find(x=>x.properties.id===id);
  
  const ll = f
    ? L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0])
    : (m.getLatLng ? m.getLatLng() : m.getBounds().getCenter());
  document.querySelector('.mapwrap').scrollIntoView({behavior:'smooth',block:'nearest'});
  if(!m.getLatLng){
    map.fitBounds(m.getBounds().pad(0.3),{maxZoom:16,animate:false});
  } else if(map.getZoom() < (SCALE_VIEWZ[p.scale]||0)){
    map.setView(ll, SCALE_VIEWZ[p.scale], {animate:false});
  } else {
    map.panTo(ll);
  }
  selectPlace(id);
}


function selectPlace(id){
  selId = id;
  showRec(id);
  render();
}


document.getElementById('loclist').addEventListener('click',e=>{
  const it = e.target.closest('.uitem');
  if(!it) return;
  e.stopPropagation();     
  openPlace(it.dataset.id);
});


function matchesQ(id){
  return !q || (searchText[id]||'').includes(q);
}


document.getElementById('q').addEventListener('input',e=>{
  q = fold(e.target.value.trim());
  render();
});


document.addEventListener('click',e=>{
  const a = e.target.closest('.placelink');
  if(!a) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if(a.dataset.eye){
    enterEye(a.dataset.eye);
    document.getElementById('map').scrollIntoView({behavior:'smooth',block:'center'});
    return;
  }
  map.closePopup();
  closeRec();
  openPlace(a.dataset.id);
});


const recPop = document.createElement('div');
recPop.id = 'recpop';
recPop.hidden = true;
document.body.appendChild(recPop);

recPop.addEventListener('pointerdown',e=>{
  const h = e.target.closest('.pop-h');
  if(!h) return;
  e.preventDefault();
  const r = recPop.getBoundingClientRect();
  const dx = e.clientX - r.left;
  const dy = e.clientY - r.top;
  recPop.style.transform = 'none';
  recPop.style.left = r.left+'px';
  recPop.style.top = r.top+'px';
  try{ recPop.setPointerCapture(e.pointerId); }catch(_){}
  function move(ev){
    recPop.style.left = Math.min(innerWidth-60, Math.max(60-r.width, ev.clientX-dx))+'px';
    recPop.style.top = Math.min(innerHeight-40, Math.max(8, ev.clientY-dy))+'px';
  }
  function up(){
    try{ recPop.releasePointerCapture(e.pointerId); }catch(_){}
    recPop.removeEventListener('pointermove',move);
    recPop.removeEventListener('pointerup',up);
    recPop.removeEventListener('pointercancel',up);
  }
  recPop.addEventListener('pointermove',move);
  recPop.addEventListener('pointerup',up);
  recPop.addEventListener('pointercancel',up);
});


function showRec(id){
  const r = allRecords.find(x=>x.id===id);
  if(!r) return;
  recPop.innerHTML = `<button id="recclose" aria-label="close">&times;</button>` + popupHTML(r);
  recPop.hidden = false;
  recPop.scrollTop = 0;
  recPop._id = id;                  
  map.doubleClickZoom.disable();    
  document.getElementById('recclose').addEventListener('click',closeRec);
}


function closeRec(){
  recPop.hidden = true;
  recPop.style.left = '';
  recPop.style.top = '';
  recPop.style.transform = '';     
  map.doubleClickZoom.enable();
  if(selId){
    selId = null;
    render();
  }
}


document.getElementById('unloc').addEventListener('click',e=>{
  const it = e.target.closest('.uitem');
  if(!it) return;
  e.stopPropagation();
  if(selId){ selId = null; render(); }   
  showRec(it.dataset.id);
});


document.addEventListener('dblclick',e=>{
  if(!recPop.hidden && !recPop.contains(e.target)) closeRec();
});


function popupHTML(p){
  const e = p.end_year;
  const ae = (p.attested_end==null) ? p.attested_start : p.attested_end;
  const attestedNow = (p.attested_start!=null && year>=p.attested_start && year<=ae);
  let status;
  if(p.start_year && year<p.start_year) status = 'not yet founded';
  else if(e && year>e) status = 'removed / absent';
  else if(attestedNow) status = 'present - a dated source covers this year';
  else status = 'present - claimed, but no source is dated to this year';

  const srcs = p.evidence.length
    ? srcRows(p.evidence)
    : '<div class="evo">no source mentions it directly</div>';

  const nIn = (p.neg_evidence||[]).filter(e=>stoodIn(p,e.year));
  const nOut = (p.neg_evidence||[]).filter(e=>!stoodIn(p,e.year));
  let negs = '';
  if(nIn.length){
    negs += `<div class="pop-srcttl">Left out by sources made in its lifetime (${nIn.length}):</div>` + srcRows(nIn);
  }
  if(nOut.length){
    negs += `<div class="pop-srcttl">Also searched, absent (${nOut.length}):</div>`
         + '<div class="evo">made before it existed, after it was removed, or undated</div>'
         + srcRows(nOut);
  }

  const cl = claimsOf(p);
  const unplaced = !markers[p.id];
  const geom = unplaced
    ? '<div class="pop-srcttl">Location:</div><div class="evo">no coordinates on record - listed in the panel but not plotted</div>'
    : geomLocated(p,cl);
  return popupBody(p,status,geom,srcs,negs);
}


const EV_TYPE = {
  'Existence / mention':'mentions it',
  'Negative (searched-absent)':'',
  'Geometry (Setting)':'maps it',
  'Name':'names it',
  'Erasure event':'records its removal',
  'Type':'records its type',
  'Implied / inferred':'implies it'
};


function srcRows(list){
  const g = {};
  list.forEach(a=>{
    if(!g[a.source]) g[a.source] = {origin:a.origin, n:0, types:new Set()};
    const e = g[a.source];
    e.n++;
    const t = EV_TYPE[a.type] ?? a.type;
    if(t) e.types.add(t);
  });

  return Object.entries(g).map(([title,v])=>{
    const count = v.n>1 ? '&times;'+v.n : '';
    const types = v.types.size ? ' · '+[...v.types].join(' · ') : '';
    return `<div class="ev"><span class="ev-k">${count}</span><span class="ev-v"><span class="evttl">${title}</span> <span class="evo">${v.origin}${types}</span></span></div>`;
  }).join('');
}


const METHOD = {
  'Georeferenced map GCP':'read from a georeferenced map',
  'Georeferenced map read':'read from a georeferenced map',
  'Modern landmark identification (testimony + OpenStreetMap)':'matched to a present-day landmark from testimony',
  'Morphological identification (unlabeled cluster + testimony)':'identified from an unlabelled building cluster and testimony'
};


const FOOT_MAP = [
  [/^GORPAN1895/, 'French canal map, Gorgona to Panama, 1895'],
  [/^CULEBRACAMPS|^Culebra Div\. encampment/, 'Culebra Division encampment plans, 1907'],
  [/^ICC Surveys 1905-06 Map No\.(\d)/, 'Isthmian Canal Commission surveys, 1905–06, map $1'],
  [/^ICC1911/, 'Property map of the Canal Zone, 1911'],
  [/^ICC1909/, 'Isthmian Canal Commission map of the Canal Zone, 1909'],
  [/^ATLANTIC1947/, 'Map of the Atlantic terminal cities, 1947'],
  [/^PACIFIC1947/, 'Map of the Pacific terminal cities, 1947'],
  [/^CENSUS1940/, 'Census district map, 1940'],
  [/^GUACHAPALI1890/, 'French plan of Guachapali, 1890'],
  [/^General map of Empire/, 'General map of Empire, circa 1909'],
  [/^Canal Zone and Vicinity 1947/, 'Canal Zone and Vicinity, 1947'],
  [/^Map of New Town near Culebra/, 'Map of New Town near Culebra, 1905'],
  [/^Map of Gorgona/, 'Map of Gorgona'],
  [/^Map of Culebra/, 'Map of Culebra']
];


function footSrc(src){
  const t = String(src||'');
  for(const [re,label] of FOOT_MAP){
    const m = t.match(re);
    if(m) return label.replace('$1', m[1]||'');
  }
  const plain = t.split(' - ')[0].replace(/\s*\((?:re-anchored|audit trace)[^)]*\)|\s*\[[^\]]*\]/g,'');
  return plain || 'a georeferenced map';
}


function geomLocated(p,cl){
  if(cl.length){
    const rows = cl.map(c=>{
      const unc = c.uncertainty_m ? '±'+c.uncertainty_m+'m' : '';
      const method = METHOD[c.method] ?? c.method;
      return `<div class="ev"><span class="ev-k">${unc}</span><span class="ev-v"><span class="evttl">${c.source}</span> <span class="evo">${c.origin} · ${method}</span></span></div>`;
    }).join('');
    const spread = p.claim_spread_m
      ? `<div class="evo">the sources disagree by up to ${p.claim_spread_m} m; both claims are kept</div>`
      : '';
    return `<div class="pop-srcttl">Where each source puts it (${cl.length}):</div>` + rows + spread;
  }
  if(footprints[p.id]){
    const fs = footprints[p.id].features;
    const titles = [...new Set(fs.map(f=>footSrc(f.properties.source)))].join('; ');
    return `<div class="pop-srcttl">Location:</div><div class="evo">extent${fs.length>1?'s':''} traced from ${titles}</div>`;
  }
  if(statedRadius(p)){
    return `<div class="pop-srcttl">Location:</div><div class="evo">extent drawn at the stated ${statedRadius(p)} m uncertainty radius</div>`;
  }
  if(extentUnrecorded(p)){
    return '<div class="pop-srcttl">Location:</div><div class="evo">no extent on record - the symbol has a fixed size and is not a measured area</div>';
  }
  return '';
}


function popupBody(p,status,geom,srcs,negs){
  const byName = {};
  p.evidence.forEach(a=>{
    if(!a.name || !a.name.trim()) return;
    const k = a.name.trim();
    if(!byName[k]) byName[k] = {year:null, n:0, src:a.source};
    const e = byName[k];
    e.n++;
    if(a.year!=null && (e.year==null || a.year<e.year)){
      e.year = a.year;
      e.src = a.source;
    }
  });
  const names = Object.entries(byName);
  let ribbon = '';
  if(names.length>=2){
    names.sort((a,b)=>(a[1].year||9999)-(b[1].year||9999));
    ribbon = `<div class="pop-srcttl">Names as recorded:</div>` + names.map(([nm,v])=>{
      const many = v.n>1 ? v.n+' sources, first: ' : '';
      return `<div class="ev"><span class="ev-k">${v.year||'undated'}</span><span class="ev-v"><b>${nm}</b> <span class="evo">${many}${v.src}</span></span></div>`;
    }).join('');
  }

  const rels = relationsOf(p.id);
  let relHtml = '';
  if(rels.length){
    relHtml = `<div class="pop-srcttl">Relations:</div>` + rels.map(r=>{
      const yrs = r.start ? `${r.start}${r.end?'–'+r.end:''}` : '';
      const note = r.note ? ` <span class="evo">${r.note}</span>` : '';
      return `<div class="ev"><span class="ev-k">${yrs}</span><span class="ev-v">${relText(r,p.id)}${note}</span></div>`;
    }).join('');
  }

 
  const kids = (kidsOf[p.name] && p.scale==='Town') ? kidsOf[p.name] : [];
  let kidsHtml = '';
  if(kids.length){
    kidsHtml = `<div class="pop-srcttl">Features within ${p.name} (${kids.length}):</div>` + kids.map(k=>{
      const tail = markers[k.id] ? '' : '; unlocated';
      return `<div class="ev"><span class="ev-k">${k.scale}</span><span class="ev-v"><a href="#" class="placelink" data-id="${k.id}">${k.name}</a> <span class="evo">${k.place_type}${tail}</span></span></div>`;
    }).join('');
  }

  let parentTxt = '';
  if(p.parent){
    const link = idByName[p.parent]
      ? `<a href="#" class="placelink" data-id="${idByName[p.parent]}">${p.parent}</a>`
      : p.parent;
    parentTxt = ' &middot; part of ' + link;
  }

  const nSrc = p.n_sources ?? p.evidence.length;
  const mentions = p.evidence.length > (p.n_sources||0) ? `, across ${p.evidence.length} mentions` : '';

  return `<div class="pop">
    <div class="pop-h">${p.name} <span class="pop-id">${p.id}</span></div>
    <div class="pop-sub">${p.scale?p.scale+' &middot; ':''}${p.place_type} &middot; ${p.theme}${parentTxt}</div>
    ${p.note?`<div class="pop-note">${p.note}</div>`:''}
    <div class="pop-tags">
      <span>~${p.start_year||'?'}-${p.end_year||'persists'}</span>
      <span>spatial: ${p.spatial_certainty}</span>
      ${p.population_type?`<span>${p.population_type}</span>`:''}
      ${p.lifespan_absent?`<span class="warn">left out by ${p.lifespan_absent} source${p.lifespan_absent>1?'s':''} made in its lifetime</span>`:''}
      ${p.sources_disagree?'<span class="warn">sources disagree</span>':''}
      ${p.coord_status==='placeholder'?'<span class="warn">placeholder location</span>':''}
    </div>
    <div class="pop-status"><span class="ev-k">at ${year}</span><span class="ev-v">${status}</span></div>
    ${geom}${ribbon}${relHtml}${kidsHtml}
    <div class="pop-srcttl">Sources (${nSrc}${mentions}):</div>${srcs}${negs}</div>`;
}


let srcSort = 'date';


function srcYear(s){
  const m = /\d{4}/.exec(s.date||'');
  return m ? +m[0] : 9999;
}

function buildSrcList(){
  const counts = {};
  function bucket(sid){
    if(!counts[sid]) counts[sid] = {pos:new Set(), neg:new Set()};
    return counts[sid];
  }
  allRecords.forEach(r=>{
    r.evidence.forEach(a=>bucket(a.source_id).pos.add(r.id));
    (r.neg_evidence||[]).forEach(a=>bucket(a.source_id).neg.add(r.id));
  });

  const rows = sourcesMeta.filter(s=>counts[s.id]);
  if(srcSort==='alpha') rows.sort((a,b)=>a.title.localeCompare(b.title));
  else rows.sort((a,b)=>srcYear(a)-srcYear(b) || a.title.localeCompare(b.title));

  document.getElementById('srclist').innerHTML = rows.map(s=>{
    const c = counts[s.id];
    const neg = c.neg.size ? ` <span class="src-neg">+ ${c.neg.size} searched-absent</span>` : '';
    return `<div class="src-row" data-s="${s.id}"><div class="src-ttl">${s.title}</div>
      <div class="un-co">${originTag(s.origin)} ${s.date} &middot; ${c.pos.size} place${c.pos.size!==1?'s':''}${neg}</div></div>`;
  }).join('');
  document.querySelectorAll('.src-row').forEach(el=>{
    el.addEventListener('click',()=>enterEye(el.dataset.s));
  });
}

document.querySelectorAll('#srcsort .sortbtn').forEach(b=>b.addEventListener('click',()=>{
  if(srcSort===b.dataset.mode) return;
  srcSort = b.dataset.mode;
  document.querySelectorAll('#srcsort .sortbtn').forEach(x=>x.classList.toggle('on',x===b));
  document.getElementById('srcsub').textContent = (srcSort==='alpha')
    ? 'select a source to see only the places it records, ordered alphabetically by title'
    : 'select a source to see only the places it records, ordered from earliest to latest';
  buildSrcList();
}));


function digScore(d){
  d = (d||'').toLowerCase();
  if(d.startsWith('full')) return 3;
  if(d.startsWith('partial')) return 2;
  if(d.startsWith('minimal')) return 1;
  return 0;
}

function escH(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


const ORIGINS = [
  ['panama',    /panamanian/i,                    'Panama'],
  ['caribbean', /caribbean|west indian/i,         'Caribbean'],
  ['france',    /french|france/i,                 'France'],
  ['britain',   /british|united kingdom/i,        'Britain'],
  ['us',        /\bUS\b|\bPRR\b|Panama Railroad|[Uu]nited [Ss]tates|[Zz]onian/, 'United States'],
  ['mixed',     /mixed/i,                         'Mixed'],
  ['secondary', /secondary|later scholarship/i,   'Later scholarship']
];

function originOf(txt){
  const o = ORIGINS.find(([,re])=>re.test(txt||''));
  if(!o) return {key:'mixed', label:'Unrecorded'};
  return {key:o[0], label:o[2]};
}


function originDetail(txt){
  return String(txt||'')
    .replace(/^(Colonial power|Colonized)\s*[—-]\s*/i,'')
    .replace(/\bUS\b/g,'United States')
    .replace(/\bPRR\b/g,'Panama Railroad')
    .replace(/\bLOC\b/g,'Library of Congress');
}


function originTag(txt){
  const o = originOf(txt);
  return `<span class="otag o-${o.key}" title="origin: ${escH(originDetail(txt))}">${o.label}</span>`;
}


function archUnsearched(a){
  return /not yet searched/i.test(a.scope||'');
}


function sortName(t){
  return (t||'').replace(/^(the|la|el|les?)\s+/i,'');
}


function byText(x,y){
  return sortName(x).localeCompare(sortName(y),'en',{sensitivity:'base'});
}

let institutions = [];


function groupInstitutions(){
  const by = new Map();
  archivesMeta.forEach(a=>{
    const k = a.institution || a.name;
    if(!by.has(k)) by.set(k,{name:k, cols:[]});
    by.get(k).cols.push(a);
  });
  institutions = [...by.values()].sort((x,y)=>byText(x.name,y.name));
  institutions.forEach(g=>{
    g.cols.sort((x,y)=>byText(x.name,y.name) || x.id.localeCompare(y.id));
  });
}


function colSources(a){
  return sourcesMeta.filter(s=>s.archive===a.id)
    .sort((x,y)=>srcYear(x)-srcYear(y) || x.title.localeCompare(y.title));
}


function meterHTML(sc){
  return [1,2,3].map(k=>`<i${sc>=k?' class="on"':''}></i>`).join('');
}


function originTags(cols){
  const seen = new Set();
  const first = cols.filter(a=>{
    const k = originOf(a.affiliation).key;
    if(seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return first.map(a=>originTag(a.affiliation)).join('');
}


function buildArchives(){
  groupInstitutions();
  document.getElementById('archlist').innerHTML = institutions.map((g,i)=>{
    const sc = Math.max(...g.cols.map(a=>digScore(a.digitization)));
    const n = g.cols.reduce((t,a)=>t+colSources(a).length, 0);
    const nc = g.cols.length;
    const unsearched = g.cols.every(archUnsearched)
      ? '<span class="arch-unsearched">not yet searched</span>' : '';
    return `<div class="arch-row" data-i="${i}" tabindex="0" role="button">
      <div class="src-ttl">${escH(g.name)}</div>
      <div class="arch-line">${originTags(g.cols)}
        <span class="arch-meter" title="best digitization among its collections">${meterHTML(sc)}</span>
        <span class="un-co">${nc} collection${nc!==1?'s':''} &middot; ${n} source${n!==1?'s':''}</span>
        ${unsearched}</div>
    </div>`;
  }).join('');

  const list = document.getElementById('archlist');
  function open(e){
    const r = e.target.closest('.arch-row');
    if(!r) return;
    e.stopPropagation();
    showArchive(+r.dataset.i);
  }
  list.addEventListener('click',open);
  list.addEventListener('keydown',e=>{
    if(e.key==='Enter' || e.key===' '){
      e.preventDefault();
      open(e);
    }
  });
  if(!archivesMeta.length) document.getElementById('archives').hidden = true;
}


function showArchive(i){
  const g = institutions[i];
  if(!g) return;
  if(selId){ selId = null; render(); }
  const n = g.cols.reduce((t,a)=>t+colSources(a).length, 0);

  function colBlock(a){
    const holdings = (a.holdings||'').split(' ; ').filter(Boolean)
      .map(h=>`<li>${escH(h)}</li>`).join('');
    const srcs = colSources(a);
    const oos = (a.scope||'').toUpperCase().startsWith('OUT');
    const srcBlock = srcs.length
      ? `<div class="pop-srcttl">Sources drawn from this collection (${srcs.length}):</div>
           <ul class="arch-hold arch-srcs">${srcs.map(s=>`<li>${originTag(s.origin)} <span class="placelink" data-eye="${s.id}">${escH(s.title)}</span> <span class="evo">(${escH(s.date)})</span></li>`).join('')}</ul>`
      : `<div class="pop-srcttl">Sources drawn from this collection:</div>
           <div class="arch-nosrc">none: searched, or used to georeference a map, but no source in this study comes from it</div>`;
    return `<div class="arch-col">
      <div class="arch-colh">${escH(a.name)} <span class="pop-id">${escH(a.id)}</span></div>
      <div class="pop-sub">${escH(a.repository)}${a.period?' &middot; '+escH(a.period):''}</div>
      <div class="pop-tags arch-tags">${originTag(a.affiliation)}<span class="arch-acc">${escH(a.access)}</span>${archUnsearched(a)?'<span class="arch-unsearched">not yet searched</span>':''}${oos?'<span class="warn">out of scope</span>':''}</div>
      <div class="ev"><span class="ev-k">origin</span><span class="ev-v">${escH(originDetail(a.affiliation))}</span></div>
      <div class="ev"><span class="ev-k">digitized</span><span class="ev-v"><span class="arch-meter">${meterHTML(digScore(a.digitization))}</span> ${escH(a.digitization)}</span></div>
      ${a.formats?`<div class="ev"><span class="ev-k">formats</span><span class="ev-v">${escH(a.formats)}</span></div>`:''}
      <div class="pop-srcttl">Holdings:</div>
      <ul class="arch-hold">${holdings}</ul>
      ${srcBlock}
    </div>`;
  }

  recPop.innerHTML = `<button id="recclose" aria-label="close">&times;</button><div class="pop">
    <div class="pop-h">${escH(g.name)}</div>
    <div class="pop-sub">${g.cols.length} collection${g.cols.length!==1?'s':''} searched &middot; ${n} source${n!==1?'s':''} in this study</div>
    ${g.cols.map(colBlock).join('')}</div>`;
  recPop.hidden = false;
  recPop.scrollTop = 0;
  recPop._id = null;             
  map.doubleClickZoom.disable();
  document.getElementById('recclose').addEventListener('click',closeRec);
}


function enterEye(sid){
  exitEye(true);
  map.closePopup();
  closeRec();
  const s = sourcesMeta.find(x=>x.id===sid);
  if(!s) return;
  eyeSrc = sid;
  eyeLayer = L.layerGroup().addTo(map);

  const locIdx = {};
  feats.forEach(f=>{ locIdx[f.properties.id] = f; });

  const entries = [];
  const unplottable = [];
  allRecords.forEach(r=>{
    const pos = r.evidence.filter(a=>a.source_id===sid);
    const neg = (r.neg_evidence||[]).filter(a=>a.source_id===sid);
    if(!pos.length && !neg.length) return;
    const f = locIdx[r.id];
    if(!f){
      unplottable.push(r.name + ((neg.length&&!pos.length) ? ' (searched, absent)' : ''));
      return;
    }
    const claim = (f.properties.geometry_claims||[]).find(c=>c.source_id===sid);
    const named = pos.find(a=>a.name && a.name.trim());
    entries.push({
      rec: r,
      ll: claim ? [claim.lat,claim.lng] : [f.geometry.coordinates[1], f.geometry.coordinates[0]],
      ownCoord: !!claim,
      pos: pos.length>0,
      name: (named && named.name) || r.name
    });
  });

  const label = entries.length<=14;  
  entries.forEach(e=>{
    const mk = e.pos
      ? L.circleMarker(e.ll,{radius:6, color:'#3b3630', fillColor:'#3b3630', fillOpacity:0.9, weight:0})
      : L.circleMarker(e.ll,{radius:7, color:CORAL, fillOpacity:0, weight:2, dashArray:'3 3'});
    mk.bindTooltip(e.name + (e.pos?'':' — searched, absent'),
      {permanent:label, direction:'right', className:'eyetip'});
    mk.bindPopup(`<div class="pop"><div class="pop-h">${e.name}</div>
      <div class="pop-sub">as recorded by ${s.title}${e.ownCoord?', at its own stated coordinate':''}</div>
      ${e.pos?'':'<div class="evo">this source was searched for it and does not record it</div>'}
      <div class="evo">this study calls it: ${e.rec.name} (${e.rec.id})</div></div>`);
    eyeLayer.addLayer(mk);
  });

  feats.forEach(f=>{
    const m = markers[f.properties.id];
    m.setStyle({opacity:0,fillOpacity:0});
    setFill(m,'none',0);
  });
  relLayer.remove();

  const bar = document.getElementById('eyebar');
  const also = unplottable.length ? `; also mentioned, but not locatable: ${unplottable.join(', ')}` : '';
  bar.hidden = false;
  bar.innerHTML = `Showing one source: <b>${s.title}</b> <span class="eyesub">(${s.origin}, ${s.date}) — `
    + `${entries.length} place${entries.length!==1?'s':''} plotted${also}`
    + `. The time and filter controls apply to the main view only.</span> <button id="eyeexit">exit</button>`;
  document.getElementById('eyeexit').addEventListener('click',()=>exitEye());
  writeHash();
}


function exitEye(silent){
  if(eyeLayer){
    eyeLayer.remove();
    eyeLayer = null;
  }
  eyeSrc = null;
  document.getElementById('eyebar').hidden = true;
  if(!map.hasLayer(relLayer)) relLayer.addTo(map);
  if(!silent){
    render();
    writeHash();
  }
}


function epilogue(){
  const el = document.getElementById('epi');
  if(allTime || year<2000 || !allRecords.length){
    el.hidden = true;
    return;
  }
  const feat = (filt.scale==='features');
  const rows = allRecords.filter(r=>feat===nested(r));
  const located = new Set(feats.map(f=>f.properties.id));
  const unloc = rows.filter(r=>!located.has(r.id)).length;

  let standing = 0;
  let removed = 0;
  rows.forEach(r=>{
    if(!located.has(r.id)) return;
    if(r.start_year!=null && year<r.start_year) return;
    if(!r.extant && r.end_year!=null && year>r.end_year){
      removed++;
    } else {
      standing++;
    }
  });

  el.hidden = false;
  el.innerHTML = `<div class="epi-h">By ${year} — ${feat?'buildings &amp; infrastructure':'places'}</div>
    <div class="epi-stats"><span><b>${removed}</b> removed</span><span><b>${standing}</b> still ${feat?'on record':'in the record'}</span><span><b>${unloc}</b> never located</span></div>`;
}


function writeHash(){
  const h = new URLSearchParams();
  if(mode!=='atlas') h.set('view',mode);   
  if(year!==1900) h.set('y',year);
  if(allTime) h.set('all','1');
  if(!ghostsOn) h.set('ghosts','0');
  if(usbOn) h.set('usb','1');
  ['scale','dens','abs','eras'].forEach(k=>{
    if(filt[k]) h.set(k,filt[k]);
  });
  if(filt.disagree) h.set('disagree','1');
  if(eyeSrc) h.set('eye',eyeSrc);
  history.replaceState(null,'','#'+h.toString());
}

function readHash(){
  const h = new URLSearchParams(location.hash.slice(1));
  const raw = h.get('view');
  const v = (raw==='absence') ? 'density' : raw;
  if(v && LEG[v]) mode = v;
  const y = +h.get('y');
  if(h.get('y') && y>=1850 && y<=2025) year = y;
  allTime = location.hash.length<2 || h.get('all')==='1';
  if(h.get('ghosts')==='0') ghostsOn = false;
  usbOn = h.get('usb')==='1';
  ['scale','dens','abs','eras'].forEach(k=>{
    if(h.get(k)) filt[k] = h.get(k);
  });
  if(filt.abs!=='while' && filt.abs!=='never') filt.abs = '';
  if(filt.scale && filt.scale!=='features'){
    filt.scale = (filt.scale==='Town') ? '' : 'features';
  }
  filt.disagree = h.get('disagree')==='1';
  return h.get('eye');
}


function applyState(){
  document.getElementById('mode').value = mode;
  yr.value = year;
  document.getElementById('ghosts').checked = ghostsOn;
  document.getElementById('usb').checked = usbOn;
  setScaleUI();
  document.getElementById('fDens').value = filt.dens;
  document.getElementById('fAbs').value = filt.abs;
  document.getElementById('fEras').value = filt.eras;
  setViewFilters();
  document.getElementById('fDisagree').checked = filt.disagree;
}

function sw(c,o){
  const style = o
    ? 'border:1px dashed '+(c||'#999')
    : 'background:'+(c||'#fff')+';border:1px solid #bbb';
  return `<span class="sw" style="${style}"></span>`;
}

const LEG = {
  atlas:{
    d:'The opening state: every located place from every period at once, ignoring time. Press Play, or move the slider, to step through the years instead.',
    rows:[[BASE,0,'Located place, any period'],[EXTANT,0,'Extant (present-day)']]},
  reconstruction:{
    d:'The same places through time: the year on the slider decides what is drawn, and the depth of the colour says how confidently each place is located. The geometry and opacity carry certainty too, here and in every view.',
    rows:[[certC.High,0,'Located to a precise point'],[certC.Medium,0,'Located approximately'],[certC.Low,0,'Located loosely, or the sources conflict']]},
  density:{
    d:'How many distinct sources mention each place. This is visibility in the surviving archives, not importance: the thinnest records often belong to the places most thoroughly erased.',
    rows:[[denC.High,0,'High (9+ sources)'],[denC.Medium,0,'Medium (3-8 sources)'],[denC.Low,0,'Low (1-2 sources)'],[null,1,'None (0 sources)']]},
  displacement:{
    d:'How each place was removed.',
    rows:[[BLUE,0,'Submerged'],[CORAL,0,'Depopulated - not flooded'],[AMBER,0,'Relocated'],[UNKNOWN,0,'Unknown'],[EXTANT,0,'Persists (never removed)']]}
};


function setViewFilters(){
  let cleared = false;
  document.querySelectorAll('.filters .group[data-view]').forEach(g=>{
    const mine = g.dataset.view===mode;
    g.hidden = !mine;
    if(mine) return;
    g.querySelectorAll('select').forEach(sel=>{
      const k = {fDens:'dens', fAbs:'abs', fEras:'eras'}[sel.id];
      if(filt[k]){
        filt[k] = '';
        sel.value = '';
        cleared = true;
      }
    });
  });
  const anyOpen = [...document.querySelectorAll('#viewfilters .group')].some(g=>!g.hidden);
  document.getElementById('viewfilters').hidden = !anyOpen;
  return cleared;
}

function setLegend(){
  const cur = {...LEG[mode]};
  if(usbOn) cur.rows = [[ACCENT,0,'American origin (Gold & Silver Roll)'], ...cur.rows];
  const timeless = (allTime && mode!=='atlas')
    ? ' Every period is on screen at once; move the slider or press Play to step through the years instead.'
    : '';
  document.getElementById('desc').textContent = (mode==='atlas' && !allTime)
    ? 'The same places, coloured alike, with the year on the slider deciding what is drawn. Press Show all to put every period back on screen at once.'
    : cur.d + timeless;
  document.getElementById('legend').innerHTML = cur.rows
    .map(r=>`<div class="leg-row">${sw(r[0],r[1])}<span>${r[2]}</span></div>`).join('');
}

function era(y){
  if(y<1881) return 'pre-canal';
  if(y<1904) return 'French period';
  if(y<1914) return 'US construction';
  if(y<1979) return 'Canal Zone';
  if(y<2000) return 'reversion to Panama';   
  return 'Panamanian ownership';             
}

const yr = document.getElementById('yr');
const yrout = document.getElementById('yrout');

function showYear(){
  yrout.textContent = allTime ? 'all periods' : year+' · '+era(year);
  const g = document.getElementById('ghosts');
  g.disabled = allTime;
  g.closest('.chip').classList.toggle('chip-off',allTime);
  const b = document.getElementById('allper');
  b.classList.toggle('on',allTime);
  b.setAttribute('aria-pressed', allTime?'true':'false');
}


function leaveTimeless(){
  if(!allTime) return;
  allTime = false;
  setLegend();
  showYear();
}


document.getElementById('mode').addEventListener('change',e=>{
  mode = e.target.value;
  if(mode==='atlas'){ fullReset(); return; }   // Start is the opening state, not a palette
  setViewFilters();
  setLegend();
  showYear();
  renderUnloc();
  render();
  writeHash();
});


document.getElementById('allper').addEventListener('click',()=>{
  stopPlay();
  allTime = true;
  setLegend();
  showYear();
  renderUnloc();
  render();
  writeHash();
});


yr.addEventListener('input',()=>{
  leaveTimeless();
  year = +yr.value;
  showYear();
  render();
  writeHash();
});


document.getElementById('ghosts').addEventListener('change',e=>{
  ghostsOn = e.target.checked;
  render();
  writeHash();
});


document.getElementById('usb').addEventListener('change',e=>{
  usbOn = e.target.checked;
  setLegend();
  render();
  writeHash();
});


function onFilter(){
  filt.dens = document.getElementById('fDens').value;
  filt.abs = document.getElementById('fAbs').value;
  filt.eras = document.getElementById('fEras').value;
  filt.disagree = document.getElementById('fDisagree').checked;
  renderUnloc();
  render();
  writeHash();
}
['fDens','fAbs','fEras','fDisagree'].forEach(id=>{
  document.getElementById(id).addEventListener('input',onFilter);
});


function setScaleUI(){
  document.querySelectorAll('#scaleswitch .scbtn').forEach(b=>{
    b.classList.toggle('on', b.dataset.scale===filt.scale);
  });
  const f = (filt.scale==='features');
  document.getElementById('locttl').textContent = f ? 'Located buildings & infrastructure:' : 'Located places:';
  document.getElementById('unlttl').textContent = f ? 'Unlocated buildings & infrastructure:' : 'Unlocated places:';
}


document.querySelectorAll('#scaleswitch .scbtn').forEach(b=>b.addEventListener('click',()=>{
  if(filt.scale===b.dataset.scale) return;
  filt.scale = b.dataset.scale;
  setScaleUI();
  renderUnloc();
  render();
  writeHash();
}));


const whyPop = document.createElement('div');
whyPop.id = 'whypop';
whyPop.hidden = true;
document.body.appendChild(whyPop);


document.querySelectorAll('.why').forEach(el=>{
  el.dataset.why = el.getAttribute('title') || '';
  el.removeAttribute('title');
  el.setAttribute('role','button');
  el.setAttribute('aria-label','why this design choice');
  el.tabIndex = 0;
  function open(ev){
    ev.preventDefault();
    ev.stopPropagation();          
    if(!whyPop.hidden && whyPop._for===el){
      whyPop.hidden = true;
      return;
    }
    whyPop.textContent = el.dataset.why;
    whyPop._for = el;
    whyPop.style.left = '0px';
    whyPop.style.top = '0px';
    whyPop.hidden = false;
    const r = el.getBoundingClientRect();
    const pw = whyPop.offsetWidth;
    let x = r.left + scrollX - 8;
    if(x+pw > scrollX+innerWidth-12) x = Math.max(scrollX+12, scrollX+innerWidth-12-pw);
    whyPop.style.left = x+'px';
    whyPop.style.top = (r.bottom+scrollY+9)+'px';
  }
  el.addEventListener('click',open);
  el.addEventListener('keydown',ev=>{
    if(ev.key==='Enter' || ev.key===' ') open(ev);
  });
});

document.addEventListener('click',()=>{ whyPop.hidden = true; });
document.addEventListener('keydown',ev=>{
  if(ev.key==='Escape'){
    whyPop.hidden = true;
    closeRec();
  }
});


let timer = null;
const playBtn = document.getElementById('play');

function stopPlay(){
  if(timer){
    clearTimeout(timer);
    timer = null;
  }
  playBtn.textContent = 'Play';
}

function playTick(){
  if(year>=2025){ stopPlay(); return; } 
  year += 1;
  yr.value = year;
  showYear();
  render();
  writeHash();
  const gap = (year>=1905 && year<1918) ? 700 : 140;
  timer = setTimeout(playTick,gap);
}

playBtn.onclick = ()=>{
  if(timer){ stopPlay(); return; }
  if(eyeSrc) exitEye(true);
  if(allTime || year>=2025) year = 1849;
  leaveTimeless();
  yr.value = Math.max(year,1850);
  showYear();
  playBtn.textContent = 'Pause';
  playTick();
};


function fullReset(){
  stopPlay();
  if(eyeSrc) exitEye(true);
  map.closePopup();
  closeRec();
  mode = 'atlas';
  year = 1900;
  ghostsOn = true;
  usbOn = false;
  allTime = true;
  q = '';
  document.getElementById('q').value = '';
  filt.scale = '';
  filt.dens = '';
  filt.abs = '';
  filt.eras = '';
  filt.disagree = false;
  applyState();
  setLegend();
  showYear();
  renderUnloc();
  render();
  writeHash();
  map.setView(HOME_LL,HOME_Z,{animate:false});
}


{
  const gb = document.getElementById('guidebtn');
  const guide = document.getElementById('guide');
  gb.addEventListener('click',()=>guide.scrollIntoView({behavior:'smooth'}));
  new IntersectionObserver(es=>{
    gb.classList.toggle('offstage', es[0].isIntersecting);
  },{rootMargin:'0px 0px -60% 0px'}).observe(guide);
}
