const express = require('express');
const xmlrpc  = require('xmlrpc');
const twilio  = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =========================
// CONFIG ODOO
// =========================

const ODOO_URL      = 'https://telcobras-sas.odoo.com';
const ODOO_DB       = 'telcobras-sas';
const ODOO_USER     = 'operativo@telcobras.com';
const ODOO_PASSWORD = process.env.ODOO_PASSWORD;

// =========================
// CONFIG GEMINI
// =========================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// =========================
// MEMORIA DE CONVERSACIONES
// Almacena historial y datos recolectados por número de teléfono
// =========================

const sesiones = new Map();

const SESION_TTL_MS = 30 * 60 * 1000; // 30 minutos de inactividad

function obtenerSesion(telefono) {
    const ahora = Date.now();
    if (!sesiones.has(telefono)) {
        sesiones.set(telefono, {
            historial: [],
            datos: { nombre: null, telefono: null, descripcion: null, servicio: null },
            ultimaActividad: ahora
        });
    }
    const sesion = sesiones.get(telefono);
    // Resetear sesión si expiró
    if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
        sesion.historial = [];
        sesion.datos = { nombre: null, telefono: null, descripcion: null, servicio: null };
    }
    sesion.ultimaActividad = ahora;
    return sesion;
}

// Limpieza periódica de sesiones inactivas
setInterval(() => {
    const ahora = Date.now();
    for (const [tel, sesion] of sesiones.entries()) {
        if (ahora - sesion.ultimaActividad > SESION_TTL_MS) {
            sesiones.delete(tel);
        }
    }
}, 10 * 60 * 1000);

// =========================
// SYSTEM PROMPT
// =========================

const SYSTEM_PROMPT = `Eres Teli, el asistente virtual de Telcobras SAS, empresa colombiana de telecomunicaciones y automatización industrial ubicada en Cali.

Tu personalidad:
- Amable, profesional y cercano, hablas en español colombiano natural
- Eres conciso (máximo 3 líneas por respuesta en WhatsApp)
- Usas un tono cálido pero profesional, como un buen asesor colombiano
- NUNCA inventas precios ni prometes cosas que no puedes cumplir
- Si no sabes algo, dices que un asesor se comunicará pronto

Servicios de Telcobras:
- Automatización industrial y SCADA
- Telecomunicaciones y redes
- Mantenimiento de sistemas de monitoreo
- Instalación de sensores y equipos industriales
- Soporte técnico especializado

Reglas de conversación:
- Respuestas cortas y directas, máximo 2-3 oraciones
- No uses asteriscos, markdown ni emojis excesivos
- Siempre termina con una pregunta o acción clara para el usuario

Recolección de datos para soporte técnico:
- Si el usuario necesita soporte, debes recolectar en orden: nombre completo, número de contacto, descripción del problema
- Cuando ya tengas los 3 datos, confirma al usuario que su solicitud fue registrada y que un asesor lo contactará pronto
- Una vez confirmado, incluye al final de tu respuesta exactamente esta línea (sin mostrarla al usuario de forma visible):
  ##CREAR_LEAD##

Detección de intención:
- Si el usuario saluda, responde amablemente y pregunta en qué puedes ayudar
- Si el usuario pregunta por servicios, explica brevemente los servicios de Telcobras
- Si el usuario quiere soporte o tiene un problema técnico, inicia el flujo de recolección de datos
- Si el usuario quiere hablar con un asesor humano, dile que lo conectarás pronto y responde con ##ESCALAR##
- Si el usuario dice algo fuera de contexto o no relacionado con Telcobras, redirige amablemente`;

// =========================
// UTILIDADES
// =========================

function limpiarTelefono(numero) {
    return String(numero || '')
        .replace('whatsapp:', '')
        .replace('+', '')
        .trim();
}

function extraerFlags(texto) {
    return {
        crearLead: texto.includes('##CREAR_LEAD##'),
        escalar:   texto.includes('##ESCALAR##'),
        limpio: texto
            .replace('##CREAR_LEAD##', '')
            .replace('##ESCALAR##', '')
            .trim()
    };
}

// =========================
// GEMINI - Chat con memoria
// FIX: systemInstruction debe ir en getGenerativeModel, no en startChat
// =========================

async function procesarMensaje(mensaje, sesion) {
    // Construir el system prompt con datos ya recolectados si existen
    const promptCompleto = SYSTEM_PROMPT + (
        sesion.datos.nombre || sesion.datos.descripcion
            ? `\n\nDatos ya recolectados del usuario:\n${JSON.stringify(sesion.datos, null, 2)}`
            : ''
    );

    // FIX PRINCIPAL: systemInstruction va en getGenerativeModel, no en startChat
    const modelo = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash'
        systemInstruction: promptCompleto
    });

    // Construir historial en formato Gemini
    const historialGemini = sesion.historial.map(h => ({
        role: h.role,
        parts: [{ text: h.content }]
    }));

    const chat = modelo.startChat({
        history: historialGemini,
        generationConfig: {
            maxOutputTokens: 300,
            temperature: 0.7
        }
        // IMPORTANTE: sin systemInstruction aquí
    });

    const result = await chat.sendMessage(mensaje);
    const respuesta = result.response.text().trim();

    // Actualizar historial
    sesion.historial.push({ role: 'user',  content: mensaje });
    sesion.historial.push({ role: 'model', content: respuesta });

    // Mantener historial acotado (últimos 20 turnos = 40 entradas)
    if (sesion.historial.length > 40) {
        sesion.historial = sesion.historial.slice(-40);
    }

    return respuesta;
}

// =========================
// EXTRAER DATOS DEL HISTORIAL CON GEMINI
// =========================

async function extraerDatosConGemini(historial) {
    const conversacion = historial
        .map(h => `${h.role === 'user' ? 'Usuario' : 'Teli'}: ${h.content}`)
        .join('\n');

    const prompt = `De la siguiente conversación de WhatsApp, extrae los datos del usuario si fueron mencionados.
Responde ÚNICAMENTE con un JSON válido con estas claves: nombre, telefono, descripcion, servicio.
Si un dato no fue mencionado, usa null.
No incluyas texto adicional, solo el JSON.

Conversación:
${conversacion}`;

    try {
        // Para extracción de datos usamos un modelo sin systemInstruction
        const modeloExtraccion = genAI.getGenerativeModel({ model: 'gemini-2.0-flash'})
        const result = await modeloExtraccion.generateContent(prompt);
        const texto = result.response.text().trim()
            .replace(/```json/g, '')
            .replace(/```/g, '')
            .trim();
        return JSON.parse(texto);
    } catch (err) {
        console.error("Error extrayendo datos:", err.message);
        return { nombre: null, telefono: null, descripcion: null, servicio: null };
    }
}

// =========================
// ODOO
// =========================

async function autenticarOdoo() {
    const common = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/common` });
    return new Promise((resolve, reject) => {
        common.methodCall('authenticate', [ODOO_DB, ODOO_USER, ODOO_PASSWORD, {}], (err, uid) => {
            if (err) return reject(err);
            if (!uid) return reject("Autenticación fallida en Odoo");
            resolve(uid);
        });
    });
}

function ejecutarOdoo(uid, modelo, metodo, args) {
    return new Promise((resolve, reject) => {
        const models = xmlrpc.createSecureClient({ url: `${ODOO_URL}/xmlrpc/2/object` });
        models.methodCall('execute_kw', [
            ODOO_DB, uid, ODOO_PASSWORD, modelo, metodo, args
        ], (err, res) => {
            if (err) return reject(err);
            resolve(res);
        });
    });
}

async function crearLead({ nombre, telefono, servicio, descripcion }) {
    const uid = await autenticarOdoo();
    const telefonoLimpio = limpiarTelefono(telefono);

    console.log("Creando lead Odoo:", { nombre, telefono: telefonoLimpio, servicio, descripcion });

    const leadId = await ejecutarOdoo(uid, 'crm.lead', 'create', [{
        name: `Solicitud de ${servicio || 'soporte'} - ${nombre}`,
        contact_name: nombre,
        phone: telefonoLimpio || 'No registrado',
        description: `Servicio: ${servicio || 'soporte'}\nDetalle: ${descripcion}\nOrigen: Chatbot Telcobras`
    }]);

    return leadId;
}

// =========================
// RUTA WHATSAPP
// =========================

app.post('/whatsapp', async (req, res) => {
    const MessagingResponse = twilio.twiml.MessagingResponse;
    const twiml = new MessagingResponse();

    const mensaje  = req.body.Body;
    const telefono = req.body.From;

    console.log("WhatsApp recibido:", mensaje, "| De:", telefono);

    try {
        const sesion = obtenerSesion(telefono);

        // Procesar con Gemini (con memoria de conversación)
        const respuestaRaw = await procesarMensaje(mensaje, sesion);
        const { crearLead: debeCrearLead, escalar, limpio: respuestaFinal } = extraerFlags(respuestaRaw);

        console.log("Respuesta Gemini:", respuestaFinal);
        console.log("Flags — crearLead:", debeCrearLead, "| escalar:", escalar);

        // Crear lead en Odoo si Gemini lo indica
        if (debeCrearLead) {
            try {
                const datos = await extraerDatosConGemini(sesion.historial);
                sesion.datos = { ...sesion.datos, ...datos };

                const leadId = await crearLead({
                    nombre:      sesion.datos.nombre      || 'Cliente',
                    telefono:    sesion.datos.telefono    || limpiarTelefono(telefono),
                    servicio:    sesion.datos.servicio    || 'soporte',
                    descripcion: sesion.datos.descripcion || 'Sin descripción'
                });

                console.log("Lead creado, ID:", leadId);

                // Limpiar datos de la sesión tras crear el lead
                sesion.datos = { nombre: null, telefono: null, descripcion: null, servicio: null };
            } catch (err) {
                console.error("ERROR creando lead en Odoo:", err);
            }
        }

        twiml.message(respuestaFinal);
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());

    } catch (error) {
        console.error("ERROR GENERAL:", error.message, error.stack);
        twiml.message("Disculpa, tuve un problema procesando tu mensaje. En un momento te atendemos.");
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(twiml.toString());
    }
});

// =========================
// HEALTH CHECK
// =========================

app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        gemini: !!process.env.GEMINI_API_KEY,
        odooPassword: !!process.env.ODOO_PASSWORD,
        sesionesActivas: sesiones.size
    });
});

// =========================
// SERVER
// =========================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor Telcobras corriendo en puerto ${PORT}`);
});
// force-redeploy-202604221008
