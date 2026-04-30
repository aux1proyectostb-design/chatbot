require('dotenv').config();
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

const ODOO_URL = 'https://telcobras-sas.odoo.com';
const ODOO_DB = 'telcobras-sas';
const ODOO_USER = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

const genAI = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// =====================================================
// MEMORIA
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
      cliente: null,
      historial: [],
      ultimoTicket: null,
      pendienteRegistro: false,
      esperandoDato: null,
      tempNombre: null,
      tempCiudad: null,
      problemaPendiente: null,
      ultimaActividad: ahora
    });
  }

  const sesion = sesiones.get(telefono);

  if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
    sesion.historial = [];
    sesion.problemaPendiente = null;
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

function capitalizarTexto(txt = '') {
  return txt
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function esSaludo(txt = '') {
  txt = txt.toLowerCase().trim();
  return ['hola', 'buenas', 'hello', 'menu', 'menú', 'buen dia', 'buen día'].includes(txt);
}

function esGracias(txt = '') {
  txt = txt.toLowerCase();
  return txt.includes('gracias') || txt.includes('muchas gracias') || txt.includes('te agradezco') || txt.includes('ok gracias') || txt === 'listo';
}

function esDespedida(txt = '') {
  txt = txt.toLowerCase();
  return txt.includes('hasta luego') || txt.includes('adios') || txt.includes('chao') || txt.includes('nos vemos');
}

function pareceSoporte(txt = '') {
  txt = txt.toLowerCase();
  return (
    txt.includes('internet') ||
    txt.includes('wifi') ||
    txt.includes('red') ||
    txt.includes('conexion') ||
    txt.includes('conexión') ||
    txt.includes('sin servicio') ||
    txt.includes('sin señal') ||
    txt.includes('intermitente') ||
    txt.includes('lento')
  );
}

function enHorarioLaboral() {
  const ahora = new Date();
  const dia = ahora.getDay(); // 0 domingo
  const hora = ahora.getHours();
  const minuto = ahora.getMinutes();
  const total = hora * 60 + minuto;

  if (dia === 0) return false;
  if (dia >= 1 && dia <= 5) {
    return total >= (7 * 60 + 30) && total <= (17 * 60);
  }
  if (dia === 6) {
    return total >= (8 * 60) && total <= (12 * 60);
  }
  return false;
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

    const ids = await ejecutarOdoo(
      uid,
      'res.partner',
      'search',
      [[['phone', 'ilike', tel]]]
    );

    if (!ids.length) return null;

    const data = await ejecutarOdoo(
      uid,
      'res.partner',
      'read',
      [[ids[0]], ['name', 'phone', 'city', 'company_name']]
    );

    return data[0];

  } catch {
    return null;
  }
}

async function crearCliente(datos) {
  try {
    const uid = await autenticarOdoo();

    return await ejecutarOdoo(
      uid,
      'res.partner',
      'create',
      [[{
        name: datos.nombre,
        phone: datos.telefono,
        city: datos.ciudad,
        company_name: datos.empresa
      }]]
    );

  } catch {
    return null;
  }
}

// =====================================================
// TICKETS
// =====================================================

async function crearTicket(datos) {
  const uid = await autenticarOdoo();

  return await ejecutarOdoo(
    uid,
    'helpdesk.ticket',
    'create',
    [[{
      name: `${datos.prioridadTexto} - ${datos.nombre}`,
      team_id: 7,
      priority: String(datos.prioridad),
      partner_name: datos.nombre,
      partner_phone: datos.telefono,
      description:
`${datos.descripcion}

Empresa: ${datos.empresa}
Ciudad: ${datos.ciudad}`
    }]]
  );
}

async function consultarTicket(idTicket) {
  try {
    const uid = await autenticarOdoo();

    const data = await ejecutarOdoo(
      uid,
      'helpdesk.ticket',
      'read',
      [[Number(idTicket)], ['id', 'stage_id', 'name']]
    );

    if (!data.length) return null;

    return data[0];

  } catch {
    return null;
  }
}

// =====================================================
// IA PRIORIDAD
// =====================================================

async function detectarPrioridadIA(texto) {
  try {
    const prompt = `
Clasifica prioridad:

Nivel 1:
Sin internet total, operación detenida.

Nivel 2:
Intermitencia, lentitud, parcial.

Nivel 3:
Consulta menor.

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

    const limpio = (result.text || '').replace(/```json/g, '').replace(/```/g, '').trim();
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
// CREAR TICKET
// =====================================================

async function procesarTicket(texto, sesion, telefono) {
  const prioridad = await detectarPrioridadIA(texto);

  const ticketId = await crearTicket({
    nombre: sesion.cliente.name,
    telefono,
    ciudad: sesion.cliente.city || 'No indica',
    empresa: sesion.cliente.company_name || 'No indica',
    descripcion: texto,
    prioridad: prioridad.prioridad,
    prioridadTexto: prioridad.texto
  });

  sesion.ultimoTicket = { id: ticketId };

  let horarioTxt = '';

  if (!enHorarioLaboral()) {
    horarioTxt = '\n\nTu solicitud fue registrada fuera de horario laboral y será atendida en la próxima jornada hábil.';
  }

  return `Ya registré tu solicitud.

Ticket No. ${ticketId}
Prioridad: ${prioridad.texto}
Tiempo estimado inicial: ${prioridad.sla}.${horarioTxt}`;
}

// =====================================================
// BOT CENTRAL
// =====================================================

async function responderBot(mensaje, sesion, telefono) {
  const txt = limpiarTexto(mensaje);
  const lower = txt.toLowerCase();

  // Buscar cliente
  if (!sesion.cliente) {
    const cliente = await buscarClientePorTelefono(telefono);
    if (cliente) {
      cliente.name = capitalizarTexto(cliente.name || '');
      cliente.city = capitalizarTexto(cliente.city || '');
      cliente.company_name = capitalizarTexto(cliente.company_name || '');
      sesion.cliente = cliente;
    }
  }

  // Saludo
  if (esSaludo(txt)) {
    return menuPrincipal(sesion.cliente?.name || '');
  }

  // Gracias
  if (esGracias(txt)) {
    return `Con mucho gusto${sesion.cliente?.name ? ' ' + sesion.cliente.name : ''}. Quedamos atentos.`;
  }

  // Despedida
  if (esDespedida(txt)) {
    return `Con gusto${sesion.cliente?.name ? ' ' + sesion.cliente.name : ''}. Que tengas un excelente día.`;
  }

  // Registro pendiente
  if (!sesion.cliente && sesion.pendienteRegistro) {

    if (sesion.esperandoDato === 'nombre') {
      sesion.tempNombre = capitalizarTexto(txt);
      sesion.esperandoDato = 'empresa';
      return 'Perfecto. ¿Me indicas el nombre de tu empresa por favor?';
    }

    if (sesion.esperandoDato === 'empresa') {
      sesion.tempEmpresa = capitalizarTexto(txt);
      sesion.esperandoDato = 'ciudad';
      return 'Gracias. ¿Me indicas tu ciudad por favor?';
    }

    if (sesion.esperandoDato === 'ciudad') {

      const nombre = sesion.tempNombre;
      const empresa = sesion.tempEmpresa;
      const ciudad = capitalizarTexto(txt);

      await crearCliente({
        nombre,
        telefono,
        ciudad,
        empresa
      });

      sesion.cliente = {
        name: nombre,
        city: ciudad,
        company_name: empresa
      };

      sesion.pendienteRegistro = false;
      sesion.esperandoDato = null;

      let respuesta = `Gracias ${nombre}. Ya quedaste registrado.`;

      if (sesion.problemaPendiente) {
        respuesta += `\n\n${await procesarTicket(sesion.problemaPendiente, sesion, telefono)}`;
        sesion.problemaPendiente = null;
      } else {
        respuesta += '\n\n¿En qué puedo ayudarte hoy?';
      }

      return respuesta;
    }
  }

  // Menú
  if (txt === '1') return 'Perfecto. Cuéntame qué necesitas cotizar.';
  if (txt === '2') return 'Claro que sí. Cuéntame el inconveniente presentado.';
  if (txt === '3') return 'Con gusto. Indícame ciudad, dirección y detalle de la visita.';
  if (txt === '4') return 'Prestamos servicios de telecomunicaciones, redes, soporte técnico, automatización industrial y mantenimiento.';
  if (txt === '5') return 'Perfecto. Te conectaremos con uno de nuestros asesores.';

  // Usuario nuevo
  if (!sesion.cliente) {

    if (pareceSoporte(txt)) {
      sesion.problemaPendiente = txt;
    }

    sesion.pendienteRegistro = true;
    sesion.esperandoDato = 'nombre';

    return 'Antes de continuar, por favor indícame tu nombre para registrarte.';
  }

  // Consultar ticket
  if (lower.includes('estado de mi ticket') || lower.includes('ticket')) {

    if (sesion.ultimoTicket) {
      const ticket = await consultarTicket(sesion.ultimoTicket.id);

      if (ticket) {
        const estado = Array.isArray(ticket.stage_id) ? ticket.stage_id[1] : 'En gestión';
        return `Claro ${sesion.cliente.name}. Tu ticket No. ${ticket.id} se encuentra en estado: ${estado}.`;
      }

      return `Claro ${sesion.cliente.name}. Tu ticket No. ${sesion.ultimoTicket.id} continúa en gestión.`;
    }

    return 'Por favor indícame el número del ticket a consultar.';
  }

  // Soporte directo
  if (pareceSoporte(txt)) {
    return await procesarTicket(txt, sesion, telefono);
  }

  // IA general simple
  return `Claro ${sesion.cliente.name}, cuéntame por favor cómo puedo ayudarte.`;
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

    console.log('Mensaje recibido:', telefono, mensaje);

    const sesion = obtenerSesion(telefono);

    const respuesta = await responderBot(mensaje, sesion, telefono);

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
    console.error('ERROR GENERAL:', error.response?.data || error.message);
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
