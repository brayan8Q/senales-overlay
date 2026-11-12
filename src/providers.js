/**
 * Las IA que el panel puede consultar, con la misma forma para las tres:
 *   list(key)            -> modelos de la cuenta (tambien comprueba la clave)
 *   chat(models)         -> los que sirven para conversar
 *   pick(models, pref)   -> cual usar
 *   ask({key, model, snapshot, timeoutMs, force}) -> { dir, confidence, reason }
 */
const openai = require('./ai');
const gemini = require('./ai-gemini');
const claude = require('./ai-claude');

// SENALES_AI_BASE_URL permite a las pruebas apuntar a un servidor falso.
const openaiBase = () => process.env.SENALES_AI_BASE_URL || openai.DEFAULT_BASE_URL;

const PROVIDERS = {
  openai: {
    name: 'ChatGPT',
    company: 'OpenAI',
    keyFile: 'openai.key',
    configKey: 'aiModel',
    keysPage: openai.KEYS_PAGE,
    list: (key) => openai.listModels({ baseUrl: openaiBase(), key }),
    chat: openai.chatModels,
    pick: openai.pickModel,
    ask: (options) => openai.askDirection({ baseUrl: openaiBase(), ...options }),
  },
  gemini: {
    name: 'Gemini',
    company: 'Google',
    keyFile: 'gemini.key',
    configKey: 'geminiModel',
    keysPage: gemini.KEYS_PAGE,
    list: (key) => gemini.listModels({ key }),
    chat: gemini.chatModels,
    pick: gemini.pickModel,
    ask: (options) => gemini.askDirection(options),
  },
  claude: {
    name: 'Claude',
    company: 'Anthropic',
    keyFile: 'claude.key',
    configKey: 'claudeModel',
    keysPage: claude.KEYS_PAGE,
    list: (key) => claude.listModels({ key }),
    chat: claude.chatModels,
    pick: claude.pickModel,
    ask: (options) => claude.askDirection(options),
  },
};

module.exports = { PROVIDERS };
