const express = require('express');
const xmlrpc = require('xmlrpc');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG META WHATSAPP
// =========================

const META_TOKEN = process.env.META_TOKEN;
const VERIFY_TOKEN = 'telcobras2026';
const PHONE_NUMBER_ID = '1052042771330730';
const SOPORTE_ALERTA = '573161966020';

// =========================
// CONFIG ODOO
// =========================

const ODOO_URL = 'https://telcobras-sas.odoo.com';
const ODOO_DB = 'telcobras-sas';
const ODOO_USER = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

// =========================
// CONFIG GEMINI
// =========================

const genAI = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// =========================
// MEMORIA
// =========================

const sesiones = new Map();
const mensajesProcesados = new Set();
const SESION_TTL_MS = 30 * 60 * 1000;

function obtenerSesion(telefono) {

    const ahora = Date.now();

    if (!sesiones.has(telefono)) {
        sesiones.set(telefono, {
            historial: [],
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

// =========================
// PROMPT
// =========================

const SYSTEM_PROMPT = `
Eres Teli, asesora virtual oficial de Telcobras SAS.

Empresa colombiana con sede en Cali y cobertura nacional.

Tu estilo:
- Profesional
- Corporativo
- Cercano
- Natural
- Sin emojis
- Sin sonar robótica
- Respuestas breves (máximo 3 líneas)

Horario:
Lunes a viernes de 7:30 a.m. a 5:00 p.m.
Sábados en horario laboral.

Servicios:
- Telecomunicaciones
- Redes empresariales
- Automatización industrial
- SCADA
- Sensores
- Soporte técnico remoto y en sitio
- Mantenimiento

Cuando un cliente salude responde:

Buen día, le saluda Teli de Telcobras SAS.

Con gusto le apoyaré. Por favor indíqueme la opción que desea gestionar:

1. Cotizaciones y ventas
2. Soporte técnico
3. Programar visita técnica
4. Información de servicios
5. Hablar con un asesor

También puede escribir directamente su necesidad.

Si detectas intención comercial:
Solicita nombre, empresa, ciudad, teléfono y necesidad.
Cuando tengas datos agrega:
##CREAR_LEAD##

Si detectas soporte:
Solicita nombre, empresa, ciudad, teléfono y descripción de la falla.
Cuando tengas datos agrega:
##CREAR_TICKET##

Si piden asesor humano:
Agrega:
##ESCALAR##
`;

// =========================
// UTILIDADES
// =========================

function extraerFlags(texto) {

    return {
        crearLead: texto.includes('##CREAR_LEAD##'),
        crearTicket: texto.includes('##CREAR_TICKET##'),
        escalar: texto.includes('##ESCALAR##'),
        limpio: texto
            .replaceAll('##CREAR_LEAD##', '')
            .replaceAll('##CREAR_TICKET##', '')
            .replaceAll('##ESCALAR##', '')
            .trim()
    };
}

function limpiarTelefono(numero = '') {

    let tel = String(numero).replace(/\D/g, '');

    if (tel.length === 10) tel = '57' + tel;
    if (tel.length > 12) tel = tel.slice(-12);

    return tel;
}

function detectarTelefono(texto = '') {

    const match = texto.match(/(\+?\d[\d\s\-]{7,20})/);

    if (!match) return null;

    return limpiarTelefono(match[1]);
}

function limpiarTexto(txt = '') {
    return String(txt).trim().replace(/\s+/g, ' ');
}

// =========================
// PRIORIDAD IA + FALLBACK
// =========================

function detectarPrioridadFallback(descripcion = '', empresa = '') {

    const txt = String(descripcion).toLowerCase();
    const emp = String(empresa).toLowerCase();

    let impacto = 1;
    let severidad = 1;
    let urgencia = 1;

    if (
        txt.includes('sin internet total') ||
        txt.includes('no hay internet') ||
        txt.includes('sin servicio') ||
        txt.includes('planta parada') ||
        txt.includes('scada caido') ||
        txt.includes('servidor caido') ||
        txt.includes('no funciona nada')
    ) severidad = 3;

    else if (
        txt.includes('intermitente') ||
        txt.includes('se va y vuelve') ||
        txt.includes('se cae') ||
        txt.includes('lento') ||
        txt.includes('lentitud') ||
        txt.includes('error')
    ) severidad = 2;

    if (
        txt.includes('toda la sede') ||
        txt.includes('todos') ||
        txt.includes('nadie tiene internet')
    ) impacto = 3;

    else if (
        txt.includes('varios usuarios') ||
        txt.includes('oficina')
    ) impacto = 2;

    if (
        txt.includes('urgente') ||
        txt.includes('ya')
    ) urgencia = 3;

    const vip = ['media commerce', 'mediacommerce', 'comfandi', 'scania'];

    if (vip.some(v => emp.includes(v))) {
        impacto = Math.max(impacto, 2);
    }

    const score = impacto + severidad + urgencia;

    if (score >= 8 || (impacto === 3 && severidad === 3)) {
        return {
            prioridad: '3',
            texto: 'NIVEL 1 CRITICO',
            sla: '15 minutos',
            motivo: 'Alto impacto operacional'
        };
    }

    if (score >= 5) {
        return {
            prioridad: '2',
            texto: 'NIVEL 2 IMPORTANTE',
            sla: '1 hora',
            motivo: 'Afectación parcial relevante'
        };
    }

    return {
        prioridad: '1',
        texto: 'NIVEL 3 NORMAL',
        sla: '4 horas',
        motivo: 'Solicitud menor'
    };
}

async function detectarPrioridadIA(descripcion = '', empresa = '') {

    try {

        const prompt = `
Eres coordinador de soporte de Telcobras SAS.

Clasifica:

Nivel 1 Crítico:
caída total, operación detenida, sin internet total.

Nivel 2 Importante:
intermitencia, lentitud severa, falla parcial importante.

Nivel 3 Normal:
consulta, solicitud menor, visita, requerimiento básico.

Empresa: ${empresa}
Caso: ${descripcion}

Responde SOLO JSON:

{
 "prioridad":"1 o 2 o 3",
 "texto":"NIVEL ...",
 "sla":"15 minutos / 1 hora / 4 horas",
 "motivo":"breve"
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

        const json = JSON.parse(limpio);

        if (!json.prioridad) throw new Error('sin prioridad');

        return json;

    } catch (error) {

        return detectarPrioridadFallback(
            descripcion,
            empresa
        );
    }
}

// =========================
// IA CHAT
// =========================

async function procesarMensaje(mensaje, sesion) {

    const historial = sesion.historial
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const prompt = `
${SYSTEM_PROMPT}

Historial:
${historial}

Usuario: ${mensaje}
`;

    const result = await genAI.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
    });

    const respuesta = (result.text || '').trim();

    sesion.historial.push({ role: 'user', content: mensaje });
    sesion.historial.push({ role: 'model', content: respuesta });

    if (sesion.historial.length > 30) {
        sesion.historial = sesion.historial.slice(-30);
    }

    return respuesta;
}

// =========================
// EXTRAER DATOS
// =========================

async function extraerDatosConGemini(historial, telefonoWhatsapp = '') {

    const conversacion = historial
        .map(h => `${h.role}: ${h.content}`)
        .join('\n');

    const prompt = `
Extrae:

nombre
telefono
empresa
ciudad
descripcion
servicio

Responder SOLO JSON válido.

${conversacion}
`;

    try {

        const result = await genAI.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt
        });

        const limpio = (result.text || '')
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();

        const datos = JSON.parse(limpio);

        return {
            nombre: limpiarTexto(datos.nombre || 'Cliente'),
            telefono: limpiarTelefono(
                datos.telefono ||
                detectarTelefono(conversacion) ||
                telefonoWhatsapp
            ),
            empresa: limpiarTexto(datos.empresa || 'No indica'),
            ciudad: limpiarTexto(datos.ciudad || 'No indica'),
            descripcion: limpiarTexto(datos.descripcion || 'Sin detalle'),
            servicio: limpiarTexto(datos.servicio || 'General')
        };

    } catch (error) {

        return {
            nombre: 'Cliente',
            telefono: limpiarTelefono(telefonoWhatsapp),
            empresa: 'No indica',
            ciudad: 'No indica',
            descripcion: 'Sin detalle',
            servicio: 'General'
        };
    }
}

// =========================
// ODOO
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

async function crearLead(datos) {

    const uid = await autenticarOdoo();

    return await ejecutarOdoo(uid, 'crm.lead', 'create', [{
        name: `${datos.servicio} - ${datos.empresa}`,
        contact_name: datos.nombre,
        partner_name: datos.empresa,
        phone: datos.telefono,
        city: datos.ciudad,
        description: datos.descripcion
    }]);
}

async function crearTicket(datos) {

    const uid = await autenticarOdoo();

    let prioridadOdoo = '1';

    if (String(datos.prioridad) === '3') prioridadOdoo = '3';
    else if (String(datos.prioridad) === '2') prioridadOdoo = '2';
    else prioridadOdoo = '1';

    return await ejecutarOdoo(uid, 'helpdesk.ticket', 'create', [{
        name: `${datos.prioridadTexto} - ${datos.empresa}`,
        team_id: 7,
        priority: prioridadOdoo,
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

async function enviarAlertaSoporte(datos) {

    try {

        await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: SOPORTE_ALERTA,
                text: {
                    body:
`ALERTA ${datos.prioridadTexto}

Cliente: ${datos.nombre}
Empresa: ${datos.empresa}
Telefono: ${datos.telefono}

Caso:
${datos.descripcion}

SLA: ${datos.sla}`
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${META_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

    } catch (error) {
        console.error(error.response?.data || error.message);
    }
}

// =========================
// WEBHOOK
// =========================

app.get('/webhook', (req, res) => {

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
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

        const telefono = message.from;
        const mensaje = message.text?.body || '';

        console.log('WhatsApp recibido:', mensaje);

        const sesion = obtenerSesion(telefono);

        let respuestaRaw;

        try {
            respuestaRaw = await procesarMensaje(mensaje, sesion);
        } catch {
            respuestaRaw = 'Gracias por escribir a Telcobras.';
        }

        let {
            crearLead: debeLead,
            crearTicket: debeTicket,
            limpio: respuestaFinal
        } = extraerFlags(respuestaRaw);

        if (debeLead || debeTicket) {

            const datos = await extraerDatosConGemini(
                sesion.historial,
                telefono
            );

            if (debeLead) {

                const leadId = await crearLead(datos);

                respuestaFinal += `

Solicitud registrada.
Caso No. ${leadId}.`;
            }

            if (debeTicket) {

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

                respuestaFinal += `

Su solicitud fue registrada exitosamente.
Ticket No. ${ticketId}
Prioridad: ${nivel.texto}
Tiempo estimado inicial: ${nivel.sla}.`;

                if (nivel.prioridad === '3') {
                    await enviarAlertaSoporte(ticket);
                }
            }
        }

        await axios.post(
            `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: telefono,
                text: { body: respuestaFinal }
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