const express = require('express');
const xmlrpc = require('xmlrpc');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =====================================================
// CONFIG
// =====================================================

const META_TOKEN = process.env.META_TOKEN;
const VERIFY_TOKEN = 'telcobras2026';
const PHONE_NUMBER_ID = '1052042771330730';
const SOPORTE_ALERTA = '573161966020';

const ODOO_URL = 'https://telcobras-sas.odoo.com';
const ODOO_DB = 'telcobras-sas';
const ODOO_USER = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// =====================================================
// MEMORIA LOCAL
// =====================================================

const sesiones = new Map();
const mensajesProcesados = new Set();
const SESION_TTL_MS = 24 * 60 * 60 * 1000;

// =====================================================
// SESION
// =====================================================

function obtenerSesion(telefono) {
  const ahora = Date.now();

  if (!sesiones.has(telefono)) {
    sesiones.set(telefono, {
      historial: [],
      cliente: null,
      ultimoTicket: null,
      pendienteRegistro: false,
      esperandoDato: null,
      ultimaActividad: ahora
    });
  }

  const sesion = sesiones.get(telefono);

  if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
    sesion.historial = [];
  }

  sesion.ultimaActividad = ahora;

  return sesion;
}

// =====================================================
// UTILIDADES
// =====================================================

function limpiarTelefono(numero = '') {
  let tel = String(numero).replace(/\D/g, '');

  if (tel.length === 10) tel = '57' + tel;
  if (tel.length > 12) tel = tel.slice(-12);

  return tel;
}

function limpiarTexto(txt = '') {
  return String(txt).trim().replace(/\s+/g, ' ');
}

function esSaludo(txt = '') {
  txt = txt.toLowerCase().trim();

  return [
    'hola',
    'buenas',
    'hello',
    'menu',
    'menú',
    'buen dia',
    'buen día'
  ].includes(txt);
}

function esGracias(txt = '') {
  txt = txt.toLowerCase();

  return (
    txt.includes('gracias') ||
    txt.includes('ok gracias') ||
    txt.includes('muchas gracias') ||
    txt.includes('te agradezco') ||
    txt.includes('listo')
  );
}

function menuPrincipal(nombre = '') {

  if (nombre) {
    return `Hola ${nombre}, qué gusto saludarte nuevamente.

¿En qué puedo ayudarte hoy?

1. Cotizaciones y ventas
2. Soporte técnico
3. Programar visita técnica
4. Información de servicios
5. Hablar con asesor`;
  }

  return `Hola, soy Teli de Telcobras SAS.

Con gusto te ayudo.

1. Cotizaciones y ventas
2. Soporte técnico
3. Programar visita técnica
4. Información de servicios
5. Hablar con asesor`;
}

// =====================================================
// ODOO BASE
// =====================================================

async function autenticarOdoo() {

  const common = xmlrpc.createSecureClient({
    url: `${ODOO_URL}/xmlrpc/2/common`
  });

  return new Promise((resolve, reject) => {

    common.methodCall(
      'authenticate',
      [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}],
      (err, uid) => err ? reject(err) : resolve(uid)
    );
  });
}

function ejecutarOdoo(uid, modelo, metodo, args) {

  return new Promise((resolve, reject) => {

    const models = xmlrpc.createSecureClient({
      url: `${ODOO_URL}/xmlrpc/2/object`
    });

    models.methodCall(
      'execute_kw',
      [ODOO_DB, uid, ODOO_PASSWORD, modelo, metodo, args],
      (err, res) => err ? reject(err) : resolve(res)
    );
  });
}

// =====================================================
// CLIENTES
// =====================================================

async function buscarClientePorTelefono(numero) {

  try {

    const uid = await autenticarOdoo();

    const tel = limpiarTelefono(numero);

    const ids = await ejecutarOdoo(uid, 'res.partner', 'search', [[
      '|',
      ['phone', 'ilike', tel],
      ['mobile', 'ilike', tel]
    ]]);

    if (!ids.length) return null;

    const data = await ejecutarOdoo(uid, 'res.partner', 'read', [
      [ids[0]],
      ['name', 'phone', 'mobile', 'city']
    ]);

    return data[0];

  } catch {
    return null;
  }
}

async function crearCliente(datos) {

  const uid = await autenticarOdoo();

  return await ejecutarOdoo(uid, 'res.partner', 'create', [{
    name: datos.nombre,
    phone: datos.telefono,
    mobile: datos.telefono,
    city: datos.ciudad
  }]);
}

// =====================================================
// TICKETS
// =====================================================

async function crearTicket(datos) {

  const uid = await autenticarOdoo();

  return await ejecutarOdoo(uid, 'helpdesk.ticket', 'create', [{
    name: `${datos.prioridadTexto} - ${datos.nombre}`,
    team_id: 7,
    priority: String(datos.prioridad),
    partner_name: datos.nombre,
    partner_phone: datos.telefono,
    description:
`${datos.descripcion}

Ciudad: ${datos.ciudad}`
  }]);
}

async function buscarTicket(ticketId) {

  try {

    const uid = await autenticarOdoo();

    const data = await ejecutarOdoo(uid, 'helpdesk.ticket', 'read', [
      [Number(ticketId)],
      ['id', 'name', 'stage_id', 'priority']
    ]);

    if (!data.length) return null;

    return data[0];

  } catch {
    return null;
  }
}

// =====================================================
// PRIORIDAD IA
// =====================================================

async function detectarPrioridadIA(texto) {

  try {

    const prompt = `
Clasifica prioridad soporte:

Nivel 1:
sin internet total, operación detenida.

Nivel 2:
intermitencia, lentitud, parcial.

Nivel 3:
consulta menor.

Caso:
${texto}

Responder SOLO JSON:

{
 "prioridad":"1 o 2 o 3",
 "texto":"NIVEL 1 o NIVEL 2 o NIVEL 3",
 "sla":"15 minutos / 1 hora / 4 horas"
}
`;

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    const limpio = (result.text || '')
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();

    return JSON.parse(limpio);

  } catch {

    return {
      prioridad: '1',
      texto: 'NIVEL 3',
      sla: '4 horas'
    };
  }
}

// =====================================================
// IA GENERAL
// =====================================================

async function conversarIA(mensaje, nombre = '') {

  try {

    const prompt = `
Eres Teli, asistente empresarial de Telcobras SAS.

Habla:
- Profesional
- Humana
- Cercana
- Respuestas cortas
- Máximo 2 líneas

Cliente: ${nombre || 'Cliente'}

Usuario:
${mensaje}
`;

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });

    return (result.text || '').trim();

  } catch {
    return 'Con gusto te ayudo.';
  }
}

// =====================================================
// BOT CENTRAL
// =====================================================

async function responderBot(mensaje, sesion, telefono) {

  const txt = limpiarTexto(mensaje);
  const lower = txt.toLowerCase();

  // -------------------------------------------------
  // CARGAR CLIENTE
  // -------------------------------------------------

  if (!sesion.cliente) {
    const cliente = await buscarClientePorTelefono(telefono);
    if (cliente) sesion.cliente = cliente;
  }

  // -------------------------------------------------
  // SALUDO
  // -------------------------------------------------

  if (esSaludo(txt)) {
    return menuPrincipal(sesion.cliente?.name || '');
  }

  // -------------------------------------------------
  // AGRADECIMIENTO
  // -------------------------------------------------

  if (esGracias(txt)) {
    return `Con mucho gusto${sesion.cliente?.name ? ' ' + sesion.cliente.name : ''}. Quedamos atentos.`;
  }

  // -------------------------------------------------
  // REGISTRO NUEVO CLIENTE
  // -------------------------------------------------

  if (!sesion.cliente && sesion.pendienteRegistro) {

    if (sesion.esperandoDato === 'nombre') {
      sesion.tempNombre = txt;
      sesion.esperandoDato = 'ciudad';
      return 'Perfecto. ¿Me indicas tu ciudad por favor?';
    }

    if (sesion.esperandoDato === 'ciudad') {

      await crearCliente({
        nombre: sesion.tempNombre,
        ciudad: txt,
        telefono
      });

      sesion.cliente = {
        name: sesion.tempNombre,
        city: txt
      };

      sesion.pendienteRegistro = false;
      sesion.esperandoDato = null;

      return `Gracias ${sesion.cliente.name}. Ya quedaste registrado. ¿En qué puedo ayudarte hoy?`;
    }
  }

  // -------------------------------------------------
  // OPCIONES MENU
  // -------------------------------------------------

  if (txt === '1') {
    return 'Perfecto. Cuéntame qué producto o servicio deseas cotizar.';
  }

  if (txt === '2') {
    return 'Claro que sí. Cuéntame el inconveniente presentado.';
  }

  if (txt === '3') {
    return 'Con gusto. Indícame ciudad, dirección y detalle de la visita requerida.';
  }

  if (txt === '4') {
    return 'Prestamos servicios de telecomunicaciones, redes, soporte técnico, automatización industrial y mantenimiento.';
  }

  if (txt === '5') {
    return 'Perfecto. Te conectaremos con uno de nuestros asesores.';
  }

  // -------------------------------------------------
  // SI NO EXISTE CLIENTE Y YA HABLA NORMAL
  // -------------------------------------------------

  if (!sesion.cliente) {
    sesion.pendienteRegistro = true;
    sesion.esperandoDato = 'nombre';

    return `Antes de continuar, por favor indícame tu nombre para registrarte.`;
  }

  // -------------------------------------------------
  // CONSULTA TICKET
  // -------------------------------------------------

  if (
    lower.includes('estado de mi ticket') ||
    lower.includes('mi ticket') ||
    lower.includes('ticket')
  ) {

    if (sesion.ultimoTicket) {
      return `Claro ${sesion.cliente.name}. Tu ticket No. ${sesion.ultimoTicket.id} continúa en gestión.`;
    }

    return 'Claro. Indícame por favor el número del ticket para revisarlo.';
  }

  // si manda solo numero ticket
  if (/^\d+$/.test(txt) && txt.length <= 6) {

    const ticket = await buscarTicket(txt);

    if (ticket) {
      return `Ticket No. ${ticket.id} se encuentra actualmente en proceso.`;
    }

    return 'No encontré información asociada a ese ticket.';
  }

  // -------------------------------------------------
  // SOPORTE INTERNET
  // -------------------------------------------------

  if (
    lower.includes('internet') ||
    lower.includes('red') ||
    lower.includes('wifi')
  ) {

    const prioridad = await detectarPrioridadIA(txt);

    const ticketId = await crearTicket({
      nombre: sesion.cliente.name,
      telefono,
      ciudad: sesion.cliente.city || 'No indica',
      descripcion: txt,
      prioridad: prioridad.prioridad,
      prioridadTexto: prioridad.texto
    });

    sesion.ultimoTicket = {
      id: ticketId
    };

    return `Perfecto ${sesion.cliente.name}, ya registré tu solicitud.

Ticket No. ${ticketId}
Prioridad: ${prioridad.texto}
Tiempo estimado inicial: ${prioridad.sla}.`;
  }

  // -------------------------------------------------
  // RESPUESTA IA NORMAL
  // -------------------------------------------------

  return await conversarIA(txt, sesion.cliente?.name || '');

}

// =====================================================
// WEBHOOK VERIFY
// =====================================================

app.get('/webhook', (req, res) => {

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// =====================================================
// WEBHOOK RECEIVE
// =====================================================

app.post('/webhook', async (req, res) => {

  try {

    const value = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) return res.sendStatus(200);
    if (value?.statuses) return res.sendStatus(200);
    if (message.type !== 'text') return res.sendStatus(200);

    if (mensajesProcesados.has(message.id)) {
      return res.sendStatus(200);
    }

    mensajesProcesados.add(message.id);
    setTimeout(() => mensajesProcesados.delete(message.id), 3600000);

    const telefono = limpiarTelefono(message.from);
    const mensaje = message.text?.body || '';

    const sesion = obtenerSesion(telefono);

    const respuesta = await responderBot(
      mensaje,
      sesion,
      telefono
    );

    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        text: { body: respuesta }
      },
      {
        headers: {
          Authorization: `Bearer ${META_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return res.sendStatus(200);

  } catch (error) {

    console.error(error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

// =====================================================
// HEALTH
// =====================================================

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// =====================================================
// SERVER
// =====================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor Telcobras activo en ${PORT}`);
});