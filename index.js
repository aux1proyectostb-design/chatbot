const express = require('express');
const xmlrpc = require('xmlrpc');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ======================================
// CONFIG
// ======================================

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

// ======================================
// MEMORIA
// ======================================

const sesiones = new Map();
const mensajesProcesados = new Set();
const SESION_TTL_MS = 30 * 60 * 1000;

// ======================================
// SESION
// ======================================

function obtenerSesion(telefono) {
  const ahora = Date.now();

  if (!sesiones.has(telefono)) {
    sesiones.set(telefono, {
      historial: [],
      cliente: null,
      ultimoTicket: null,
      ultimaActividad: ahora
    });
  }

  const sesion = sesiones.get(telefono);

  if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
    sesion.historial = [];
    sesion.ultimoTicket = null;
  }

  sesion.ultimaActividad = ahora;
  return sesion;
}

// ======================================
// UTILIDADES
// ======================================

function limpiarTelefono(numero = '') {
  let tel = String(numero).replace(/\D/g, '');

  if (tel.length === 10) tel = '57' + tel;
  if (tel.length > 12) tel = tel.slice(-12);

  return tel;
}

function limpiarTexto(txt = '') {
  return String(txt).trim().replace(/\s+/g, ' ');
}

// ======================================
// ODOO BASE
// ======================================

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

// ======================================
// CLIENTE POR TELEFONO
// ======================================

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

    const data = await ejecutarOdoo(uid, 'read', 'res.partner', [
      [ids[0]],
      ['name', 'phone', 'mobile', 'city']
    ]);

    return data[0];

  } catch {
    return null;
  }
}

// ======================================
// CREAR TICKET
// ======================================

async function crearTicket(datos) {
  const uid = await autenticarOdoo();

  return await ejecutarOdoo(uid, 'helpdesk.ticket', 'create', [{
    name: `${datos.prioridadTexto} - ${datos.empresa}`,
    team_id: 7,
    priority: String(datos.prioridad),
    partner_name: datos.nombre,
    partner_phone: datos.telefono,
    description:
`Cliente: ${datos.nombre}
Empresa: ${datos.empresa}
Ciudad: ${datos.ciudad}
Telefono: ${datos.telefono}

${datos.descripcion}`
  }]);
}

// ======================================
// ALERTA INTERNA
// ======================================

async function enviarAlerta(ticket) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: SOPORTE_ALERTA,
        text: {
          body:
`ALERTA ${ticket.prioridadTexto}

Cliente: ${ticket.nombre}
Empresa: ${ticket.empresa}
Telefono: ${ticket.telefono}

Caso:
${ticket.descripcion}

SLA: ${ticket.sla}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${META_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch {}
}

// ======================================
// IA CENTRAL
// ======================================

async function procesarConIA(mensaje, sesion, telefono) {

  const nombre = sesion.cliente?.name || '';
  const ticket = sesion.ultimoTicket
    ? `Ticket actual: ${sesion.ultimoTicket.id}`
    : 'Sin ticket actual';

  const historial = sesion.historial
    .slice(-10)
    .map(x => `${x.role}: ${x.text}`)
    .join('\n');

  const prompt = `
Eres Teli, asistente oficial de Telcobras SAS.

Tono:
Profesional, cercano, humano, corporativo.

Cliente conocido: ${nombre || 'No'}
Telefono: ${telefono}
${ticket}

Debes responder natural y breve.

Clasifica intención y agrega solo si aplica:

##SALUDO##
##SOPORTE##
##VENTAS##
##VISITA##
##ASESOR##
##CREAR_TICKET##
##SEGUIMIENTO##
##DESPEDIDA##

Reglas:

- Si el usuario reporta una falla NUEVA -> ##CREAR_TICKET##
- Si pregunta por caso anterior -> ##SEGUIMIENTO##
- Si se despide o agradece -> ##DESPEDIDA##
- Si saluda -> ##SALUDO##

Historial:
${historial}

Usuario:
${mensaje}
`;

  const result = await genAI.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt
  });

  return (result.text || '').trim();
}

// ======================================
// IA PRIORIDAD
// ======================================

async function detectarPrioridadIA(descripcion = '') {
  try {

    const prompt = `
Clasifica prioridad:

Nivel 1:
Sin internet total, operación detenida.

Nivel 2:
Intermitencia, lentitud, falla parcial.

Nivel 3:
Consulta menor.

Caso:
${descripcion}

Responder SOLO JSON:

{
 "prioridad":"1 o 2 o 3",
 "texto":"NIVEL ...",
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

// ======================================
// RESPUESTA CENTRAL
// ======================================

async function responderBot(mensaje, sesion, telefono) {

  if (!sesion.cliente) {
    const cliente = await buscarClientePorTelefono(telefono);
    if (cliente) sesion.cliente = cliente;
  }

  const respuestaIA = await procesarConIA(
    mensaje,
    sesion,
    telefono
  );

  const texto = respuestaIA
    .replace(/##[A-Z_]+##/g, '')
    .trim();

  // ----------------------
  // DESPEDIDA
  // ----------------------

  if (respuestaIA.includes('##DESPEDIDA##')) {
    return texto;
  }

  // ----------------------
  // SEGUIMIENTO
  // ----------------------

  if (respuestaIA.includes('##SEGUIMIENTO##')) {

    if (sesion.ultimoTicket) {
      return `${texto}

Tu último ticket es el No. ${sesion.ultimoTicket.id} y continúa en gestión.`;
    }

    return `${texto}

No encuentro un ticket reciente asociado. Si deseas, puedo ayudarte a registrar uno nuevo.`;
  }

  // ----------------------
  // CREAR TICKET
  // ----------------------

  if (respuestaIA.includes('##CREAR_TICKET##')) {

    const prioridad = await detectarPrioridadIA(mensaje);

    const datos = {
      nombre: sesion.cliente?.name || 'Cliente',
      empresa: sesion.cliente?.name || 'No indica',
      ciudad: sesion.cliente?.city || 'No indica',
      telefono,
      descripcion: mensaje,
      prioridad: prioridad.prioridad,
      prioridadTexto: prioridad.texto,
      sla: prioridad.sla
    };

    const ticketId = await crearTicket(datos);

    sesion.ultimoTicket = {
      id: ticketId,
      prioridad: prioridad.texto,
      sla: prioridad.sla
    };

    if (prioridad.prioridad === '3') {
      await enviarAlerta(datos);
    }

    return `${texto}

Ticket No. ${ticketId}
Prioridad: ${prioridad.texto}
Tiempo estimado inicial: ${prioridad.sla}.`;
  }

  return texto;
}

// ======================================
// WEBHOOK VERIFY
// ======================================

app.get('/webhook', (req, res) => {

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (
    mode === 'subscribe' &&
    token === VERIFY_TOKEN
  ) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// ======================================
// WEBHOOK RECEIVE
// ======================================

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
    const mensaje = limpiarTexto(message.text?.body || '');

    const sesion = obtenerSesion(telefono);

    sesion.historial.push({
      role: 'user',
      text: mensaje
    });

    const respuesta = await responderBot(
      mensaje,
      sesion,
      telefono
    );

    sesion.historial.push({
      role: 'bot',
      text: respuesta
    });

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

// ======================================
// HEALTH
// ======================================

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ======================================
// SERVER
// ======================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor Telcobras activo en ${PORT}`);
});