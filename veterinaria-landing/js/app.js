/* app.js
   Gestión completa sin base de datos. 
   Usa File System Access API cuando está disponible (Chrome/Edge). Fallback a localStorage y descarga de archivos.
*/

/* ======================
   UTILIDADES / CONST
   ====================== */
const LIMITE_DIARIO = 15;
const STOCK_MINIMO = 5;

let dirHandle = null;
let pacientes = [];
let citas = [];
let inventario = [];
let credentials = [];
let activeDetailTimer = null;

const FILE_PACIENTES = 'patients.json';
const FILE_CITAS = 'citas.json';
const FILE_INVENTARIO = 'inventario.json';
const FILE_CREDS = 'credenciales.txt';

/* ======================
   HELPERS: ID / fechas / IDB simple
   ====================== */
function uuidv4(){
  return 'xxxxxx-xxxx-4xxx-yxxx-xxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0;
    const v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

function timeToMinutes(t){
  const [h,m] = t.split(':').map(Number);
  return h*60 + m;
}
function minutesToTime(min){
  const h = Math.floor(min/60).toString().padStart(2,'0');
  const m = (min%60).toString().padStart(2,'0');
  return `${h}:${m}`;
}
function combineDateTime(dateStr, timeStr){
  return new Date(`${dateStr}T${timeStr}:00`);
}

/* ======================
   IndexedDB util (guardar handle de carpeta)
   ====================== */
function idbPut(key, value){
  return new Promise((res, rej) => {
    const rq = indexedDB.open('veterinaria-db', 1);
    rq.onupgradeneeded = e => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    rq.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('kv','readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => res(true);
      tx.onerror = ev => rej(ev);
    };
    rq.onerror = ev => rej(ev);
  });
}

function idbGet(key){
  return new Promise((res, rej) => {
    const rq = indexedDB.open('veterinaria-db', 1);
    rq.onupgradeneeded = e => {
      e.target.result.createObjectStore('kv');
    };
    rq.onsuccess = e => {
      const db = e.target.result;
      const tx = db.transaction('kv','readonly');
      const req = tx.objectStore('kv').get(key);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    };
    rq.onerror = () => rej(rq.error);
  });
}

function forceLoginModal(){
  document.querySelectorAll('.modal.show').forEach(m => {
    const inst = bootstrap.Modal.getInstance(m);
    if (inst) inst.hide();
  });
  new bootstrap.Modal(document.getElementById("loginModal")).show();
}

/* ======================
   File System Access helpers (con fallback)
   ====================== */

async function requestDirectoryHandle(){
  if('showDirectoryPicker' in window){
    try {
      const handle = await window.showDirectoryPicker({mode:'readwrite'});
      dirHandle = handle;
      try { await idbPut('dir', handle); } catch(e){ console.warn('No se pudo guardar handle en IDB', e); }
      alert('Carpeta seleccionada correctamente. Los datos se guardarán ahí.');
      return handle;
    } catch(e){
      console.warn('Usuario cancelo o error al pedir carpeta', e);
      return null;
    }
  } else {
    alert('El navegador no soporta el File System Access API. Se usará almacenamiento local (localStorage) y descargas como fallback.');
    return null;
  }
}

async function loadSavedDirHandle(){
  if(!('showDirectoryPicker' in window)) return null;
  try {
    const saved = await idbGet('dir');
    if(saved) dirHandle = saved;
    return dirHandle;
  } catch(e){
    console.warn('No se pudo recuperar el handle guardado:', e);
    return null;
  }
}

async function saveFilePlain(name, content){
  if(dirHandle){
    try {
      const fh = await dirHandle.getFileHandle(name, {create: true});
      const writable = await fh.createWritable();
      await writable.write(content);
      await writable.close();
      return true;
    } catch(e){
      console.warn('Error al escribir archivo en carpeta:', e);
    }
  }
  try {
    localStorage.setItem('file_' + name, content);
  } catch(e){
    const blob = new Blob([content], {type: 'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }
  return false;
}

async function readFilePlain(name){
  if(dirHandle){
    try {
      const fh = await dirHandle.getFileHandle(name);
      const file = await fh.getFile();
      const text = await file.text();
      return text;
    } catch(e){
      return null;
    }
  } else {
    return localStorage.getItem('file_' + name);
  }
}

/* ======================
   Persistencia JSON específica
   ====================== */
async function saveJSONFile(name, obj){
  const text = JSON.stringify(obj, null, 2);
  await saveFilePlain(name, text);
}

async function readJSONFile(name){
  const txt = await readFilePlain(name);
  if(!txt) return null;
  try {
    return JSON.parse(txt);
  } catch(e){
    console.warn('JSON inválido en', name, e);
    return null;
  }
}

/* ======================
   CARGA INICIAL DE DATOS
   ====================== */
async function inicializar(){
  await loadSavedDirHandle();

  const credsTxt = await readFilePlain(FILE_CREDS);
  credentials = [];
  if(credsTxt){
    credsTxt.split(/\r?\n/).forEach(line => {
      if(!line.trim()) return;
      const parts = line.split(';');
      credentials.push({user:parts[0], pass: parts[1]});
    });
  }

  const p = await readJSONFile(FILE_PACIENTES);
  pacientes = Array.isArray(p) ? p : [];

  const c = await readJSONFile(FILE_CITAS);
  citas = Array.isArray(c) ? c : [];

  const inv = await readJSONFile(FILE_INVENTARIO);
  inventario = Array.isArray(inv) ? inv : [];

  renderPacienteSelect();
  renderPacientesTable();
  renderCitasTable();
  actualizarBarrass();
  renderInventarioTable();
  actualizarEstadisticasInventario();
}

/* ======================
   GESTIÓN CREDENCIALES (archivo de texto)
   ====================== */
async function registrarCredencial(user, pass){
  if(!user || !pass) throw new Error('Usuario/contraseña vacíos');
  if(credentials.some(c => c.user === user)) throw new Error('Usuario ya existe');

  credentials.push({user, pass});
  const existing = await readFilePlain(FILE_CREDS) || '';
  const newline = existing && !existing.endsWith('\n') ? '\n' : '';
  await saveFilePlain(FILE_CREDS, existing + newline + `${user};${pass}\n`);
  localStorage.setItem('credentials', JSON.stringify(credentials));
  return true;
}

async function loginCredencial(user, pass){
  if(!user || !pass) throw new Error('Credenciales vacías');
  const found = credentials.find(c => c.user === user && c.pass === pass);
  if(found) return true;
  const local = JSON.parse(localStorage.getItem('credentials') || '[]');
  const lf = local.find(c => c.user===user && c.pass===pass);
  return Boolean(lf);
}

/* ======================
   PACIENTES: CRUD + cartilla vacunas
   ====================== */
function findPacienteById(id){
  return pacientes.find(p => p.id === id);
}

async function addOrUpdatePaciente(obj){
  if(!obj.id) {
    obj.id = uuidv4();
    obj.cartilla = obj.cartilla || [];
    pacientes.push(obj);
  } else {
    const idx = pacientes.findIndex(p => p.id === obj.id);
    if(idx >= 0) pacientes[idx] = obj;
  }
  await saveJSONFile(FILE_PACIENTES, pacientes);
  renderPacientesTable();
  renderPacienteSelect();
}

async function deletePaciente(id){
  pacientes = pacientes.filter(p => p.id !== id);
  citas = citas.filter(c => c.pacienteId !== id);
  await saveJSONFile(FILE_PACIENTES, pacientes);
  await saveJSONFile(FILE_CITAS, citas);
  renderPacientesTable();
  renderCitasTable();
  renderPacienteSelect();
}

/* ======================
   CITAS: CRUD + validación solapamiento
   ====================== */
function solapa(c1, c2){
  if(c1.fecha !== c2.fecha) return false;
  const s1 = timeToMinutes(c1.hora_inicio), e1 = timeToMinutes(c1.hora_fin);
  const s2 = timeToMinutes(c2.hora_inicio), e2 = timeToMinutes(c2.hora_fin);
  return (s1 < e2 && s2 < e1);
}

function existeSolapamiento(nuevaCita, excludeId=null){
  for(const c of citas){
    if(excludeId && c.id === excludeId) continue;
    if(c.doctor === nuevaCita.doctor && solapa(c, nuevaCita)) return true;
  }
  return false;
}

async function addOrUpdateCita(obj){
  const citasDelDia = citas.filter(c => c.fecha === obj.fecha);
  const isNew = !obj.id;
  if(isNew && citasDelDia.length >= LIMITE_DIARIO){
    throw new Error(`Límite diario alcanzado (${LIMITE_DIARIO})`);
  }

  if(existeSolapamiento(obj, obj.id || null)){
    throw new Error('Ya existe una cita solapada con ese doctor');
  }

  if(!obj.id){
    obj.id = uuidv4();
    obj.estado = obj.estado || 'Pendiente';
    obj.creadoAt = new Date().toISOString();
    citas.push(obj);
  } else {
    const idx = citas.findIndex(c => c.id === obj.id);
    if(idx>=0) citas[idx] = obj;
  }

  await saveJSONFile(FILE_CITAS, citas);
  renderCitasTable();
  actualizarBarrass();
}

async function eliminarCita(id){
  citas = citas.filter(c => c.id !== id);
  await saveJSONFile(FILE_CITAS, citas);
  renderCitasTable();
  actualizarBarrass();
}

async function changeEstadoCita(id, nuevoEstado){
  const idx = citas.findIndex(c => c.id === id);
  if(idx<0) return;
  citas[idx].estado = nuevoEstado;
  await saveJSONFile(FILE_CITAS, citas);
  renderCitasTable();
}

/* ======================
   INVENTARIO: CRUD
   ====================== */

function findProductoById(id){
  return inventario.find(p => p.id === id);
}

async function addOrUpdateProducto(obj){
  if(!obj.id) {
    obj.id = uuidv4();
    obj.fechaRegistro = new Date().toISOString().split('T')[0];
    inventario.push(obj);
  } else {
    const idx = inventario.findIndex(p => p.id === obj.id);
    if(idx >= 0) inventario[idx] = obj;
  }
  await saveJSONFile(FILE_INVENTARIO, inventario);
  renderInventarioTable();
  actualizarEstadisticasInventario();
}

async function deleteProducto(id){
  inventario = inventario.filter(p => p.id !== id);
  await saveJSONFile(FILE_INVENTARIO, inventario);
  renderInventarioTable();
  actualizarEstadisticasInventario();
}

function renderInventarioTable(){
  const tbody = document.querySelector('#tablaInventario tbody');
  if(!tbody) return;
  
  tbody.innerHTML = '';
  
  const categoriaFiltro = document.getElementById('filtroCategoriaInventario')?.value || '';
  const busqueda = document.getElementById('buscarProducto')?.value.toLowerCase() || '';
  
  let productosFiltrados = inventario;
  
  if(categoriaFiltro) {
    productosFiltrados = productosFiltrados.filter(p => p.categoria === categoriaFiltro);
  }
  
  if(busqueda) {
    productosFiltrados = productosFiltrados.filter(p => 
      p.nombre.toLowerCase().includes(busqueda) ||
      (p.descripcion && p.descripcion.toLowerCase().includes(busqueda))
    );
  }
  
  productosFiltrados.forEach(p => {
    const tr = document.createElement('tr');
    const total = (p.cantidad * p.precio).toFixed(2);
    const stockClass = p.cantidad <= STOCK_MINIMO ? 'text-danger fw-bold' : '';
    
    tr.innerHTML = `
      <td>${p.nombre}</td>
      <td><span class="badge bg-secondary">${p.categoria}</span></td>
      <td class="${stockClass}">${p.cantidad}</td>
      <td>$${p.precio.toFixed(2)}</td>
      <td>$${total}</td>
      <td>${p.fechaRegistro || '-'}</td>
      <td>
        <button class="btn btn-sm btn-warning" onclick="editarProducto('${p.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="confirmEliminarProducto('${p.id}')">Eliminar</button>
        <button class="btn btn-sm btn-success" onclick="addToCart('${p.id}')">🛒</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  
  if(productosFiltrados.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No hay productos que mostrar</td></tr>';
  }
}

function actualizarEstadisticasInventario(){
  const totalEl = document.getElementById('totalProductos');
  if(totalEl) totalEl.textContent = inventario.length;
  
  const medicamentosEl = document.getElementById('totalMedicamentos');
  if(medicamentosEl) {
    const count = inventario.filter(p => p.categoria === 'Medicamento').length;
    medicamentosEl.textContent = count;
  }
  
  const alimentosEl = document.getElementById('totalAlimentos');
  if(alimentosEl) {
    const count = inventario.filter(p => p.categoria === 'Alimento').length;
    alimentosEl.textContent = count;
  }
  
  const stockBajoEl = document.getElementById('totalStockBajo');
  if(stockBajoEl) {
    const count = inventario.filter(p => p.cantidad <= STOCK_MINIMO).length;
    stockBajoEl.textContent = count;
  }
}

function editarProducto(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  
  const p = findProductoById(id);
  if(!p) return alert('Producto no encontrado');
  
  document.getElementById('inventarioModalTitle').textContent = 'Editar Producto';
  document.getElementById('productoId').value = p.id;
  document.getElementById('prod_nombre').value = p.nombre;
  document.getElementById('prod_categoria').value = p.categoria;
  document.getElementById('prod_cantidad').value = p.cantidad;
  document.getElementById('prod_precio').value = p.precio;
  document.getElementById('prod_descripcion').value = p.descripcion || '';
  
  new bootstrap.Modal(document.getElementById('inventarioModal')).show();
}

function confirmEliminarProducto(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  if(confirm('¿Eliminar este producto del inventario?')) { 
    deleteProducto(id); 
  }
}

/* ======================
   RENDER / UI helpers
   ====================== */
function formatDate(d){
  if(!d) return '';
  return d;
}

function renderPacientesTable(){
  const tbody = document.querySelector('#tablaPacientes tbody');
  tbody.innerHTML = '';
  pacientes.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.nombre || ''}</td>
      <td>${p.raza || ''}</td>
      <td>${p.fecha_nac || ''}</td>
      <td>${p.responsable || ''}</td>
      <td>${p.celular || ''}</td>
      <td>
        <button class="btn btn-sm btn-info" onclick="verPaciente('${p.id}')">Ver</button>
        <button class="btn btn-sm btn-warning" onclick="editarPaciente('${p.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="confirmEliminarPaciente('${p.id}')">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPacienteSelect(){
  const sel = document.getElementById('selectPacienteExistente');
  if(!sel) return;
  sel.innerHTML = '<option value="">-- Seleccionar paciente (si aplica) --</option>';
  pacientes.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.nombre} — ${p.responsable}`;
    sel.appendChild(opt);
  });
}

function renderCitasTable(filterDate=null){
  const tbody = document.querySelector('#tablaCitas tbody');
  tbody.innerHTML = '';
  const fechaFiltro = filterDate || document.getElementById('filtroFecha').value || new Date().toISOString().split('T')[0];
  const list = citas
    .filter(c => c.fecha === fechaFiltro)
    .sort((a,b) => timeToMinutes(a.hora_inicio) - timeToMinutes(b.hora_inicio));

  list.forEach(c => {
    const tr = document.createElement('tr');
    const paciente = findPacienteById(c.pacienteId) || {nombre:c.paciente};
    tr.innerHTML = `
      <td>${c.fecha}</td>
      <td>${c.hora_inicio}</td>
      <td>${c.hora_fin}</td>
      <td>${paciente.nombre || c.paciente}</td>
      <td>${c.responsable || paciente.responsable || ''}</td>
      <td>${c.doctor}</td>
      <td>${c.estado}</td>
      <td>
        <button class="btn btn-sm btn-info" onclick="verDetalleCita('${c.id}')">Ver</button>
        <button class="btn btn-sm btn-warning" onclick="abrirEditarCita('${c.id}')">Editar</button>
        <button class="btn btn-sm btn-danger" onclick="confirmEliminarCita('${c.id}')">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

/* ======================
   BARRAS DE PROGRESO DIARIAS
   ====================== */
function actualizarBarrass(){
  const hoy = document.getElementById('filtroFecha').value || new Date().toISOString().split('T')[0];
  const citasHoy = citas.filter(c => c.fecha === hoy);
  const ocupacion = citasHoy.length;
  const capacidadPct = Math.round((ocupacion / LIMITE_DIARIO) * 100);
  const capacidadBar = document.getElementById('capacidadBar');
  capacidadBar.style.width = `${Math.min(capacidadPct,100)}%`;
  capacidadBar.textContent = `${ocupacion}/${LIMITE_DIARIO}`;

  const now = new Date();
  const pasadas = citasHoy.filter(c => combineDateTime(c.fecha, c.hora_fin) < now).length;
  const pasadasPct = citasHoy.length ? Math.round((pasadas / citasHoy.length) * 100) : 0;
  const pasadasBar = document.getElementById('pasadasBar');
  pasadasBar.style.width = `${pasadasPct}%`;
  pasadasBar.textContent = `${pasadas}/${citasHoy.length || 0}`;
}

/* ======================
   INTERACCIONES: abrir/editar/modals
   ====================== */

function verPaciente(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  const p = findPacienteById(id);
  if(!p) return alert('Paciente no encontrado');
  
  document.getElementById('pacienteModalTitle').textContent = 'Ver Paciente';
  document.getElementById('pacienteId').value = p.id;
  document.getElementById('p_nombre').value = p.nombre;
  document.getElementById('p_raza').value = p.raza;
  document.getElementById('p_fecha_nac').value = p.fecha_nac;
  document.getElementById('p_responsable').value = p.responsable;
  document.getElementById('p_celular').value = p.celular;
  document.getElementById('p_direccion').value = p.direccion;
  
  renderCartillaList(p.cartilla || []);
  
  document.querySelectorAll('#formPaciente input, #formPaciente button').forEach(el => {
    if(el.id !== 'btnAddVacuna') el.disabled = true;
  });
  document.getElementById('btnAddVacuna').style.display = 'none';
  
  new bootstrap.Modal(document.getElementById('pacienteModal')).show();
}

function editarPaciente(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  const p = findPacienteById(id);
  if(!p) return alert('Paciente no encontrado');
  
  document.getElementById('pacienteModalTitle').textContent = 'Editar Paciente';
  document.getElementById('pacienteId').value = p.id;
  document.getElementById('p_nombre').value = p.nombre;
  document.getElementById('p_raza').value = p.raza;
  document.getElementById('p_fecha_nac').value = p.fecha_nac;
  document.getElementById('p_responsable').value = p.responsable;
  document.getElementById('p_celular').value = p.celular;
  document.getElementById('p_direccion').value = p.direccion;
  
  renderCartillaList(p.cartilla || []);
  
  document.querySelectorAll('#formPaciente input, #formPaciente button').forEach(el => {
    el.disabled = false;
  });
  document.getElementById('btnAddVacuna').style.display = 'block';
  
  new bootstrap.Modal(document.getElementById('pacienteModal')).show();
}

function confirmEliminarPaciente(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  if(confirm('¿Eliminar paciente y sus citas asociadas?')) { 
    deletePaciente(id); 
  }
}

function verDetalleCita(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  const c = citas.find(x => x.id === id);
  if(!c) return alert('Cita no encontrada');
  const p = findPacienteById(c.pacienteId) || {nombre: c.paciente, responsable: c.responsable, cartilla: []};

  const cont = document.getElementById('detalleContenido');
  cont.innerHTML = `
    <div><strong>Mascota:</strong> ${p.nombre || c.paciente}</div>
    <div><strong>Responsable:</strong> ${p.responsable || c.responsable || ''}</div>
    <div><strong>Doctor:</strong> ${c.doctor}</div>
    <div><strong>Fecha:</strong> ${c.fecha}</div>
    <div><strong>Horario:</strong> ${c.hora_inicio} - ${c.hora_fin}</div>
    <div><strong>Estado:</strong> ${c.estado}</div>
    <div><strong>Generalidades:</strong> ${c.generalidades || ''}</div>`;

  const btnStart = document.getElementById('btnStartCita');
  const btnComplete = document.getElementById('btnCompleteCita');
  btnStart.onclick = async () => { await changeEstadoCita(id, 'En Progreso'); new bootstrap.Modal(document.getElementById('detalleModal')).hide(); };
  btnComplete.onclick = async () => { await changeEstadoCita(id, 'Completada'); new bootstrap.Modal(document.getElementById('detalleModal')).hide(); };

  new bootstrap.Modal(document.getElementById('detalleModal')).show();
}

function startDetalleTimer(cita){
  stopDetalleTimer();
  const targetStart = combineDateTime(cita.fecha, cita.hora_inicio);
  const targetEnd = combineDateTime(cita.fecha, cita.hora_fin);
  const el = document.getElementById('detalleTimer');

  function tick(){
    const now = new Date();
    if(now < targetStart){
      const secs = Math.floor((targetStart - now)/1000);
      el.innerHTML = `<small>Falta para iniciar: ${formatDur(secs)}</small>`;
    } else if(now >= targetStart && now < targetEnd){
      const total = Math.floor((targetEnd - targetStart)/1000);
      const elapsed = Math.floor((now - targetStart)/1000);
      const remaining = total - elapsed;
      const pct = Math.round((elapsed/total)*100);
      el.innerHTML = `<div>En progreso: ${formatDur(elapsed)} / ${formatDur(total)} (restan ${formatDur(remaining)})</div>
                      <div class="progress mt-1"><div class="progress-bar" style="width:${pct}%">${pct}%</div></div>`;
    } else {
      el.innerHTML = `<small>Finalizada hace ${formatDur(Math.floor((now - targetEnd)/1000))}</small>`;
    }
  }
  tick();
  activeDetailTimer = setInterval(tick, 1000);
}
function stopDetalleTimer(){ if(activeDetailTimer) clearInterval(activeDetailTimer); activeDetailTimer = null; }

function formatDur(sec){
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  return (h? h+'h ':'') + (m? m+'m ':'') + s+'s';
}

function abrirEditarCita(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  const c = citas.find(x=>x.id===id);
  if(!c) return alert('Cita no encontrada');
  document.getElementById('citaModalTitle').textContent = 'Editar Cita';
  document.getElementById('citaId').value = c.id;

  if(c.pacienteId){
    document.getElementById('selectPacienteExistente').value = c.pacienteId;
    document.getElementById('toggleNuevoPaciente').checked = false;
    document.getElementById('nuevoPacienteFields').style.display = 'none';
  } else {
    document.getElementById('selectPacienteExistente').value = '';
    document.getElementById('toggleNuevoPaciente').checked = true;
    document.getElementById('nuevoPacienteFields').style.display = 'block';
    document.getElementById('c_paciente').value = c.paciente;
    document.getElementById('c_responsable').value = c.responsable;
    document.getElementById('c_raza').value = c.raza || '';
    document.getElementById('c_celular').value = c.celular || '';
  }

  document.getElementById('c_fecha').value = c.fecha;
  document.getElementById('c_hora_inicio').value = c.hora_inicio;
  document.getElementById('c_hora_fin').value = c.hora_fin;
  document.getElementById('c_doctor').value = c.doctor;
  document.getElementById('c_generalidades').value = c.generalidades || '';

  new bootstrap.Modal(document.getElementById('citaModal')).show();
}

function confirmEliminarCita(id){
  if(!auth.isLoggedIn()){ 
    forceLoginModal(); 
    return; 
  }
  if(confirm('¿Eliminar cita?')) eliminarCita(id);
}

function renderCartillaList(list) {
  const el = document.getElementById('cartillaList');
  if(!el) return;
  
  el.innerHTML = '';
  
  if(!list || list.length === 0) {
    const idp = document.getElementById('pacienteId').value;
    if(idp) {
      const p = findPacienteById(idp);
      list = p ? (p.cartilla || []) : [];
    } else {
      list = window._tempCartilla || [];
    }
  }
  
  if(list.length === 0) {
    el.innerHTML = '<small class="text-muted">Sin vacunas registradas</small>';
    return;
  }
  
  list.forEach((v, index) => {
    const vacunaDiv = document.createElement('div');
    vacunaDiv.className = 'card p-2 mb-1 d-flex flex-row justify-content-between align-items-center';
    vacunaDiv.innerHTML = `
      <div>
        <div><strong>${v.nombre || 'Sin nombre'}</strong></div>
        <div class="small text-muted">Aplicada: ${v.fecha_aplicacion || '-'} / Próxima: ${v.proxima || '-'}</div>
      </div>
      <button class="btn btn-sm btn-outline-danger btn-eliminar-vacuna" data-index="${index}">×</button>
    `;
    el.appendChild(vacunaDiv);
  });

  document.querySelectorAll('.btn-eliminar-vacuna').forEach(btn => {
    btn.addEventListener('click', function() {
      const index = parseInt(this.getAttribute('data-index'));
      eliminarVacuna(index);
    });
  });
}

function eliminarVacuna(index) {
  const idp = document.getElementById('pacienteId').value;
  
  if(!idp) {
    if(window._tempCartilla && window._tempCartilla.length > index) {
      window._tempCartilla.splice(index, 1);
      renderCartillaList(window._tempCartilla);
    }
  } else {
    const p = findPacienteById(idp);
    if(p && p.cartilla && p.cartilla.length > index) {
      p.cartilla.splice(index, 1);
      addOrUpdatePaciente(p).then(() => {
        renderCartillaList(p.cartilla);
      });
    }
  }
}

/* ======================
   UTILIDADES FINALES
   ====================== */
window.verPaciente = verPaciente;
window.editarPaciente = editarPaciente;
window.confirmEliminarPaciente = confirmEliminarPaciente;
window.verDetalleCita = verDetalleCita;
window.abrirEditarCita = abrirEditarCita;
window.confirmEliminarCita = confirmEliminarCita;
window.editarProducto = editarProducto;
window.confirmEliminarProducto = confirmEliminarProducto;
window.requestDirectoryHandle = requestDirectoryHandle;

window.addEventListener('beforeunload', () => {
  saveJSONFile(FILE_PACIENTES, pacientes);
  saveJSONFile(FILE_CITAS, citas);
  saveJSONFile(FILE_INVENTARIO, inventario);
});

/* ======================
   Eventos DOM / submit forms
   ====================== */
document.addEventListener('DOMContentLoaded', async () => {
  await inicializar();

  // NAVEGACIÓN ENTRE SECCIONES

  document.getElementById('btnShowInicio').addEventListener('click', () => {
   document.getElementById('seccionInicio').style.display = '';   
   document.getElementById('seccionCitas').style.display = 'none';
   document.getElementById('seccionPacientes').style.display = 'none';
   document.getElementById('seccionInventario').style.display = 'none';
  });
  document.getElementById('btnShowCitas').addEventListener('click', () => {
    document.getElementById('seccionInicio').style.display = 'none'; 
    document.getElementById('seccionCitas').style.display = '';
    document.getElementById('seccionPacientes').style.display = 'none';
    document.getElementById('seccionInventario').style.display = 'none';
  });
  
  document.getElementById('btnShowPacientes').addEventListener('click', () => {
    document.getElementById('seccionInicio').style.display = 'none';
    document.getElementById('seccionCitas').style.display = 'none';
    document.getElementById('seccionPacientes').style.display = '';
    document.getElementById('seccionInventario').style.display = 'none';
  });
  
  document.getElementById('btnShowInventario').addEventListener('click', () => {
    if(!auth.isLoggedIn()){ 
      forceLoginModal(); 
      return; 
    }
    document.getElementById('seccionInicio').style.display = 'none';
    document.getElementById('seccionCitas').style.display = 'none';
    document.getElementById('seccionPacientes').style.display = 'none';
    document.getElementById('seccionInventario').style.display = '';
    renderInventarioTable();
    actualizarEstadisticasInventario();
  });

  document.getElementById('btnInitStorage').addEventListener('click', async () => {
    await requestDirectoryHandle();
  });

  document.getElementById('filtroFecha').value = new Date().toISOString().split('T')[0];
  document.getElementById('filtroFecha').addEventListener('change', () => {
    renderCitasTable();
    actualizarBarrass();
  });

  // FILTROS DE INVENTARIO
  const filtroCat = document.getElementById('filtroCategoriaInventario');
  const buscarProd = document.getElementById('buscarProducto');
  
  if(filtroCat) {
    filtroCat.addEventListener('change', renderInventarioTable);
  }
  
  if(buscarProd) {
    buscarProd.addEventListener('input', renderInventarioTable);
  }

  document.getElementById('toggleNuevoPaciente').addEventListener('change', (e)=>{
    document.getElementById('nuevoPacienteFields').style.display = e.target.checked ? 'block' : 'none';
  });

  // FORM PACIENTE
  document.getElementById('formPaciente').addEventListener('submit', async (ev) => {
    ev.preventDefault();

    if(!auth.isLoggedIn()){ 
      forceLoginModal(); 
      return; 
    }

    const id = document.getElementById('pacienteId').value || null;
    let cartilla = window._tempCartilla || [];

    if(id && cartilla.length === 0) {
      const p = findPacienteById(id);
      if(p && p.cartilla) cartilla = p.cartilla;
    }

    const obj = {
      id: id || undefined,
      nombre: document.getElementById('p_nombre').value,
      raza: document.getElementById('p_raza').value,
      fecha_nac: document.getElementById('p_fecha_nac').value,
      responsable: document.getElementById('p_responsable').value,
      celular: document.getElementById('p_celular').value,
      direccion: document.getElementById('p_direccion').value,
      cartilla: cartilla
    };

    await addOrUpdatePaciente(obj);
    
    bootstrap.Modal.getInstance(document.getElementById('pacienteModal')).hide();
    
    document.getElementById('formPaciente').reset();
    document.getElementById('pacienteId').value = '';
    document.getElementById('pacienteModalTitle').textContent = 'Registrar Paciente';
    window._tempCartilla = [];
    renderCartillaList([]);
    
    document.querySelectorAll('#formPaciente input, #formPaciente button').forEach(el => {
      el.disabled = false;
    });
    document.getElementById('btnAddVacuna').style.display = 'block';
  });

  document.getElementById('btnAddVacuna').addEventListener('click', (ev) => {
    ev.preventDefault();
    const nombre = document.getElementById('vacuna_nombre').value;
    const fecha = document.getElementById('vacuna_fecha').value;
    const prox = document.getElementById('vacuna_prox').value;
    
    if(!nombre || !fecha) return alert('Nombre y fecha son requeridos para la vacuna');
    
    const idp = document.getElementById('pacienteId').value;
    const nuevaVacuna = {id: uuidv4(), nombre, fecha_aplicacion: fecha, proxima: prox};
    
    if(!idp) {
      window._tempCartilla = window._tempCartilla || [];
      window._tempCartilla.push(nuevaVacuna);
      renderCartillaList(window._tempCartilla);
    } else {
      const p = findPacienteById(idp);
      if(!p.cartilla) p.cartilla = [];
      p.cartilla.push(nuevaVacuna);
      renderCartillaList(p.cartilla);
    }
    
    document.getElementById('vacuna_nombre').value = '';
    document.getElementById('vacuna_fecha').value = '';
    document.getElementById('vacuna_prox').value = '';
  });

  // FORM CITA
  document.getElementById('formCita').addEventListener('submit', async (ev)=>{
    ev.preventDefault();
    if(!auth.isLoggedIn()){ 
      forceLoginModal(); 
      return; 
    }
    const citaId = document.getElementById('citaId').value || null;
    const existePacienteId = document.getElementById('selectPacienteExistente').value;
    let pacienteId = null;

    if(existePacienteId){
      pacienteId = existePacienteId;
    } else {
      const nuevo = {
        nombre: document.getElementById('c_paciente').value,
        raza: document.getElementById('c_raza').value,
        fecha_nac: '',
        responsable: document.getElementById('c_responsable').value,
        celular: document.getElementById('c_celular').value,
        direccion: '',
        cartilla: []
      };
      await addOrUpdatePaciente(nuevo);
      pacienteId = pacientes[pacientes.length - 1].id;
    }

    const obj = {
      id: citaId || undefined,
      pacienteId,
      paciente: document.getElementById('c_paciente').value,
      responsable: document.getElementById('c_responsable').value,
      raza: document.getElementById('c_raza').value,
      celular: document.getElementById('c_celular').value,
      fecha: document.getElementById('c_fecha').value,
      hora_inicio: document.getElementById('c_hora_inicio').value,
      hora_fin: document.getElementById('c_hora_fin').value,
      doctor: document.getElementById('c_doctor').value,
      generalidades: document.getElementById('c_generalidades').value,
      estado: 'Pendiente'
    };

    try {
      await addOrUpdateCita(obj);
      bootstrap.Modal.getInstance(document.getElementById('citaModal')).hide();
      document.getElementById('formCita').reset();
      document.getElementById('citaId').value = '';
      document.getElementById('toggleNuevoPaciente').checked = true;
      document.getElementById('nuevoPacienteFields').style.display = 'block';
      renderPacienteSelect();
      renderCitasTable();
      actualizarBarrass();
    } catch(e){
      alert('Error al guardar cita: ' + e.message);
    }
  });

  // FORM INVENTARIO
  document.getElementById('formInventario').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    
    if(!auth.isLoggedIn()){ 
      forceLoginModal(); 
      return; 
    }
    
    const id = document.getElementById('productoId').value || null;
    
    const obj = {
      id: id || undefined,
      nombre: document.getElementById('prod_nombre').value,
      categoria: document.getElementById('prod_categoria').value,
      cantidad: parseInt(document.getElementById('prod_cantidad').value),
      precio: parseFloat(document.getElementById('prod_precio').value),
      descripcion: document.getElementById('prod_descripcion').value
    };
    
    await addOrUpdateProducto(obj);
    
    bootstrap.Modal.getInstance(document.getElementById('inventarioModal')).hide();
    document.getElementById('formInventario').reset();
    document.getElementById('productoId').value = '';
    document.getElementById('inventarioModalTitle').textContent = 'Agregar Producto';
  });

  document.getElementById('inventarioModal').addEventListener('show.bs.modal', () => {
    if(!document.getElementById('productoId').value) {
      document.getElementById('formInventario').reset();
      document.getElementById('inventarioModalTitle').textContent = 'Agregar Producto';
    }
  });

  document.getElementById('btnRegister').addEventListener('click', async ()=>{
    const u = document.getElementById('regUser').value.trim();
    const p = document.getElementById('regPass').value.trim();
    const msg = document.getElementById('regMsg');
    msg.textContent = '';
    try {
      await registrarCredencial(u,p);
      msg.innerHTML = '<small class="text-success">Registrado correctamente</small>';
    } catch(e){
      msg.innerHTML = `<small class="text-danger">${e.message}</small>`;
    }
  });

  document.getElementById('btnLogin').addEventListener('click', async ()=>{
    const u = document.getElementById('loginUser').value.trim();
    const p = document.getElementById('loginPass').value.trim();
    const msg = document.getElementById('loginMsg');
    msg.textContent = '';
    try {
      const ok = await loginCredencial(u,p);
      if(ok){
        msg.innerHTML = '<small class="text-success">Ingreso exitoso</small>';
        new bootstrap.Modal(document.getElementById('loginModal')).hide();
      } else {
        msg.innerHTML = '<small class="text-danger">Usuario/contraseña inválidos</small>';
      }
    } catch(e){
      msg.innerHTML = `<small class="text-danger">${e.message}</small>`;
    }
  });

  document.getElementById('btnLoginUseLocal').addEventListener('click', ()=>{
    localStorage.setItem('credentials', JSON.stringify([{user:'demo', pass:'demo'}]));
    alert('Credencial demo: demo / demo creada en localStorage. Usa esas credenciales para iniciar.');
  });

  document.getElementById('selectPacienteExistente').addEventListener('change', (ev)=>{
    const id = ev.target.value;
    if(id){
      document.getElementById('toggleNuevoPaciente').checked = false;
      document.getElementById('nuevoPacienteFields').style.display = 'none';
      const p = findPacienteById(id);
      if(p){
        document.getElementById('c_paciente').value = p.nombre;
        document.getElementById('c_responsable').value = p.responsable;
        document.getElementById('c_raza').value = p.raza || '';
        document.getElementById('c_celular').value = p.celular || '';
      }
    } else {
      document.getElementById('toggleNuevoPaciente').checked = true;
      document.getElementById('nuevoPacienteFields').style.display = 'block';
      document.getElementById('c_paciente').value = '';
      document.getElementById('c_responsable').value = '';
      document.getElementById('c_raza').value = '';
      document.getElementById('c_celular').value = '';
    }
  });

  setInterval(() => {
    const now = new Date();
    let changed = false;
    for(const c of citas){
      const start = combineDateTime(c.fecha, c.hora_inicio);
      const end = combineDateTime(c.fecha, c.hora_fin);
      if(now >= start && now < end && c.estado !== 'En Progreso'){
        c.estado = 'En Progreso';
        changed = true;
      } else if(now >= end && c.estado !== 'Completada'){
        c.estado = 'Completada';
        changed = true;
      }
    }
    if(changed){
      saveJSONFile(FILE_CITAS, citas).then(()=>{
        renderCitasTable();
        actualizarBarrass();
      });
    }
  }, 30000);

  document.getElementById('pacienteModal').addEventListener('show.bs.modal', ()=>{
    if(!document.getElementById('pacienteId').value) {
      document.getElementById('formPaciente').reset();
      document.getElementById('pacienteModalTitle').textContent = 'Registrar Paciente';
      window._tempCartilla = [];
      renderCartillaList([]);
      
      document.querySelectorAll('#formPaciente input, #formPaciente button').forEach(el => {
        el.disabled = false;
      });
      document.getElementById('btnAddVacuna').style.display = 'block';
    }
  });

  document.getElementById('pacienteModal').addEventListener('hidden.bs.modal', ()=>{
    document.getElementById('formPaciente').reset();
    document.getElementById('pacienteId').value = '';
    document.getElementById('pacienteModalTitle').textContent = 'Registrar Paciente';
    window._tempCartilla = [];
    renderCartillaList([]);
  });
});


/* ======================
   CARRITO DE COMPRAS
   ====================== */
let carrito = JSON.parse(localStorage.getItem('carrito') || '[]');

function guardarCarrito() {
  localStorage.setItem('carrito', JSON.stringify(carrito));
  mostrarCarrito();
}

function agregarAlCarrito(idProducto, cantidad = 1) {
  const producto = findProductoById(idProducto);
  if(!producto) return alert('Producto no encontrado');
  if(producto.cantidad < cantidad) return alert('No hay suficiente stock');

  const idx = carrito.findIndex(p => p.idProducto === idProducto);
  if(idx >= 0){
    if(producto.cantidad < carrito[idx].cantidad + cantidad) 
      return alert('No hay suficiente stock');
    carrito[idx].cantidad += cantidad;
  } else {
    carrito.push({
      idProducto,
      nombre: producto.nombre,
      precio: producto.precio,
      cantidad
    });
  }

  guardarCarrito();
  alert(`Se agregó ${cantidad} x ${producto.nombre} al carrito`);
}

function eliminarDelCarrito(idProducto){
  carrito = carrito.filter(p => p.idProducto !== idProducto);
  guardarCarrito();
}

function actualizarCantidadCarrito(idProducto, cantidad){
  const idx = carrito.findIndex(p => p.idProducto === idProducto);
  if(idx >= 0){
    if(cantidad <= 0){
      eliminarDelCarrito(idProducto);
    } else {
      const producto = findProductoById(idProducto);
      if(producto.cantidad < cantidad) return alert('No hay suficiente stock');
      carrito[idx].cantidad = cantidad;
    }
    guardarCarrito();
  }
}

function totalCarrito(){
  return carrito.reduce((sum, p) => sum + p.precio * p.cantidad, 0).toFixed(2);
}

function mostrarCarrito(){
  const tbody = document.querySelector('#tablaCarrito tbody');
  tbody.innerHTML = '';
  carrito.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.nombre}</td>
      <td>$${p.precio.toFixed(2)}</td>
      <td>
        <input type="number" min="1" class="form-control form-control-sm" style="width:70px" value="${p.cantidad}" data-id="${p.idProducto}">
      </td>
      <td>$${(p.precio * p.cantidad).toFixed(2)}</td>
      <td><button class="btn btn-sm btn-danger" data-id="${p.idProducto}">×</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('totalCarrito').textContent = totalCarrito();

  // eventos input cantidad
  tbody.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('change', (ev)=>{
      const id = ev.target.getAttribute('data-id');
      let cant = parseInt(ev.target.value);
      if(isNaN(cant) || cant < 1) cant = 1;
      actualizarCantidadCarrito(id, cant);
    });
  });

  // eventos eliminar
  tbody.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-id');
      eliminarDelCarrito(id);
    });
  });
}

// botón flotante para abrir carrito
const btnCarrito = document.createElement('button');
btnCarrito.className = 'btn btn-primary position-fixed';
btnCarrito.style.bottom = '20px';
btnCarrito.style.right = '20px';
btnCarrito.style.zIndex = '1055';
btnCarrito.textContent = '🛒 Carrito';
btnCarrito.setAttribute('data-bs-toggle','modal');
btnCarrito.setAttribute('data-bs-target','#modalCarrito');
document.body.appendChild(btnCarrito);

// checkout
document.getElementById('btnPagar').addEventListener('click', async ()=>{
  if(carrito.length === 0) return alert('Carrito vacío');
  
  for(const item of carrito){
    const producto = findProductoById(item.idProducto);
    if(!producto || producto.cantidad < item.cantidad){
      return alert(`Stock insuficiente de ${item.nombre}`);
    }
  }

  // restar del inventario
  carrito.forEach(item=>{
    const producto = findProductoById(item.idProducto);
    producto.cantidad -= item.cantidad;
  });

  await saveJSONFile(FILE_INVENTARIO, inventario);
  carrito = [];
  guardarCarrito();
  renderInventarioTable();
  alert('Compra realizada correctamente');
  const modal = bootstrap.Modal.getInstance(document.getElementById('modalCarrito'));
  if(modal) modal.hide();
});

// inicializar render del carrito
mostrarCarrito();
