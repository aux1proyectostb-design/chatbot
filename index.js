const express = require('express');
const xmlrpc = require('xmlrpc');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG
// =========================

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

// =========================
// MEMORIA
// =========================

const sesiones = new Map();
const mensajesProcesados = new Set();

const SESION_TTL_MS = 30 * 60 * 1000;

// =========================
// SESION
// =========================

function obtenerSesion(telefono) {

    const ahora = Date.now();

    if (!sesiones.has(telefono)) {
        sesiones.set(telefono, {
            historial: [],
            estado: 'nuevo',
            cliente: null,
            ultimaActividad: ahora
        });
    }

    const sesion = sesiones.get(telefono);

    if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
        sesion.historial = [];
        sesion.estado = 'nuevo';
        sesion.cliente = null;
    }

    sesion.ultimaActividad = ahora;

    return sesion;
}

// =========================
// UTILIDADES
// =========================

function esSaludo(txt = '') {

    const t = txt.toLowerCase().trim();

    return [
        'hola',
        'buenas',
        'buenos dias',
        'buenos días',
        'buen dia',
        'buen día',
        'hello'
    ].includes(t);
}

function esCierre(txt = '') {

    const t = txt.toLowerCase().trim();

    return [
        'gracias',
        'ok',
        'perfecto',
        'dale',
        'listo'
    ].includes(t);
}

function limpiarTelefono(numero = '') {

    let tel = String(numero).replace(/\D/g, '');

    if (tel.length === 10) tel = '57' + tel;
    if (tel.length > 12) tel = tel.slice(-12);

    return tel;
}

function limpiarTexto(txt = '') {
    return String(txt).trim().replace(/\s+/g, ' ');
}

// =========================
// MENU
// =========================

function menuPrincipal(nombre = '') {

    if (nombre) {
        return `Buen día ${nombre}.

Con gusto le apoyaré. Indíqueme la opción deseada:

1. Cotizaciones y ventas
2. Soporte técnico
3. Programar visita técnica
4. Información de servicios
5. Hablar con asesor`;
    }

    return `Buen día, le saluda Teli de Telcobras SAS.

Con gusto le apoyaré. Indíqueme la opción deseada:

1. Cotizaciones y ventas
2. Soporte técnico
3. Programar visita técnica
4. Información de servicios
5. Hablar con asesor`;
}

// =========================
// ODOO BASE
// =========================

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

// =========================
// BUSCAR CLIENTE POR TELEFONO
// =========================

async function buscarClientePorTelefono(numero) {

    try {

        const uid = await autenticarOdoo();

        const tel = limpiarTelefono(numero);

        const ids = await ejecutarOdoo(
            uid,
            'res.partner',
            'search',
            [[
                '|',
                ['phone', 'ilike', tel],
                ['mobile', 'ilike', tel]
            ]]
        );

        if (!ids.length) return null;

        const datos = await ejecutarOdoo(
            uid,
            'res.partner',
            'read',
            [
                [ids[0]],
                ['name', 'phone', 'mobile', 'city']
            ]
        );

        return datos[0];

    } catch {
        return null;
    }
}

// =========================
// PRIORIDAD IA
// =========================

async function detectarPrioridadIA(descripcion = '', empresa = '') {

    try {

        const prompt = `
Clasifica ticket empresarial.

Nivel 1:
caída total, operación detenida, sin internet.

Nivel 2:
intermitencia, lentitud severa, falla parcial.

Nivel 3:
consulta menor.

Caso: ${descripcion}
Empresa: ${empresa}

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

        const limpio = result.text
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();

        return JSON.parse(limpio);

    } catch {

        return {
            prioridad: '1',
            texto: 'NIVEL 3 NORMAL',
            sla: '4 horas'
        };
    }
}

// =========================
// EXTRAER DATOS
// =========================

async function extraerDatosIA(texto) {

    try {

        const prompt = `
Extrae:

nombre
empresa
ciudad
descripcion

Responder SOLO JSON.

Texto:
${texto}
`;

        const result = await genAI.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });

        const limpio = result.text
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();

        return JSON.parse(limpio);

    } catch {

        return {
            nombre: null,
            empresa: null,
            ciudad: null,
            descripcion: texto
        };
    }
}

// =========================
// CREAR TICKET
// =========================

async function crearTicket(datos) {

    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'helpdesk.ticket', 'create', [{
        name: `${datos.prioridadTexto} - ${datos.empresa}`,
        team_id: 7,
        priority: datos.prioridad,
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

// =========================
// ALERTA
// =========================

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
${ticket.descripcion}`
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

// =========================
// FLUJO BOT
// =========================

async function responderBot(mensaje, sesion, telefono) {

    const txt = mensaje.trim();

    // SALUDO NUEVO
    if (
        esSaludo(txt) &&
        (
            sesion.estado === 'nuevo' ||
            sesion.estado === 'cerrado'
        )
    ) {

        const cliente = await buscarClientePorTelefono(telefono);

        if (cliente) {
            sesion.cliente = cliente;
            sesion.estado = 'menu';
            return menuPrincipal(cliente.name);
        }

        sesion.estado = 'menu';
        return menuPrincipal();
    }

    // SALUDO DURANTE FLUJO
    if (esSaludo(txt)) {
        return 'Quedo atento a su solicitud.';
    }

    // CIERRE
    if (esCierre(txt)) {
        sesion.estado = 'cerrado';
        return 'Con gusto. Quedamos atentos.';
    }

    // SOPORTE
    if (txt === '2') {

        sesion.estado = 'soporte';

        if (sesion.cliente) {

            return `Buen día ${sesion.cliente.name}.

Por favor indíqueme la novedad presentada para registrar el ticket.`;
        }

        return `Gracias por elegir soporte técnico.

Por favor indíqueme:

Nombre, empresa, ciudad, teléfono y descripción de la falla.`;
    }

    // CREAR TICKET
    if (sesion.estado === 'soporte') {

        let datos = {};

        if (sesion.cliente) {

            datos = {
                nombre: sesion.cliente.name,
                empresa: sesion.cliente.name,
                ciudad: sesion.cliente.city || 'No indica',
                telefono,
                descripcion: txt
            };

        } else {

            const ia = await extraerDatosIA(txt);

            datos = {
                nombre: ia.nombre || 'Cliente',
                empresa: ia.empresa || 'No indica',
                ciudad: ia.ciudad || 'No indica',
                telefono,
                descripcion: ia.descripcion || txt
            };
        }

        const nivel = await detectarPrioridadIA(
            datos.descripcion,
            datos.empresa
        );

        const ticket = {
            ...datos,
            prioridad: nivel.prioridad,
            prioridadTexto: nivel.texto,
            sla: nivel.sla
        };

        const ticketId = await crearTicket(ticket);

        if (nivel.prioridad === '3') {
            await enviarAlerta(ticket);
        }

        sesion.estado = 'cerrado';

        return `Su solicitud fue registrada exitosamente.

Ticket No. ${ticketId}
Prioridad: ${nivel.texto}
Tiempo estimado inicial: ${nivel.sla}.`;
    }

    return menuPrincipal(
        sesion.cliente?.name || ''
    );
}

// =========================
// WEBHOOK
// =========================

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

        console.log('WhatsApp recibido:', mensaje);

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

// =========================
// HEALTH
// =========================

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

// =========================
// SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor Telcobras activo en ${PORT}`);
});