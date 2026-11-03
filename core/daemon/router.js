'use strict';

const crypto = require('node:crypto');

/**
 * JSON-RPC method router. Each handler receives (params, ctx) and returns a
 * plain serialisable result. Domain logic lives in the gateway so this file
 * stays a thin, testable dispatch table.
 */

function rpcError(message, code = -32603) {
  const err = new Error(message);
  err.rpcCode = code;
  return err;
}

function createRouter({ gateway, log }) {
  const methods = {
    // --- liveness ---------------------------------------------------------
    'daemon.ping': async () => ({ pong: true, ts: Date.now() }),
    'daemon.info': async () => gateway.info(),

    // --- campaign dashboard ----------------------------------------------
    'campaign.metrics': async () => gateway.campaignMetrics(),
    'campaign.list': async () => gateway.listCampaigns(),
    'campaign.create': async (params) => gateway.createCampaign(requireParams(params, ['name'])),
    'campaign.pause': async ({ id }) => gateway.pauseCampaign(requireParams({ id }, ['id']).id),
    'campaign.resume': async ({ id }) => gateway.resumeCampaign(requireParams({ id }, ['id']).id),

    // --- template editor --------------------------------------------------
    'template.list': async () => gateway.listTemplates(),
    'template.get': async ({ id }) => gateway.getTemplate(requireParams({ id }, ['id']).id),
    'template.save': async (params) =>
      gateway.saveTemplate(requireParams(params, ['id', 'body'])),

    // --- triage & lead inbox ---------------------------------------------
    'inbox.list': async ({ category } = {}) => gateway.listReplies({ category }),
    'inbox.classify': async ({ id, category }) =>
      gateway.classifyReply(requireParams({ id, category }, ['id', 'category'])),
    'lead.list': async ({ status } = {}) => gateway.listLeads({ status }),

    // --- providers & settings --------------------------------------------
    'providers.list': async () => gateway.listProviders(),
    'providers.test': async (params) =>
      gateway.testProvider(requireParams(params, ['provider'])),

    // --- sender personas -------------------------------------------------
    'persona.list': async () => gateway.listPersonas(),
    'persona.active': async () => gateway.getActivePersona(),
    'persona.setActive': async ({ id }) =>
      gateway.setActivePersona(requireParams({ id }, ['id']).id),
    'persona.upsert': async (params) => gateway.upsertPersona(params),
    'persona.remove': async ({ id }) =>
      gateway.removePersona(requireParams({ id }, ['id']).id),

    // --- Obsidian memory vault ------------------------------------------
    'memory.list': async ({ category } = {}) => gateway.memoryList({ category }),
    'memory.search': async ({ query }) =>
      gateway.memorySearch({ query: requireParams({ query }, ['query']).query }),
    'memory.read': async (params) => gateway.memoryRead(requireParams(params, ['category', 'slug'])),
    'memory.write': async (params) =>
      gateway.memoryWrite(requireParams(params, ['category', 'slug', 'body'])),

    // --- email transport -------------------------------------------------
    'email.status': async () => gateway.emailStatus(),
    'email.configure': async (params) => gateway.configureEmail(params),
    'email.send': async (params) =>
      gateway.sendOutreach(requireParams(params, ['to', 'subject', 'message'])),

    // --- agent chat (streaming over JSON-RPC notifications) ---------------
    'agent.chat': async (params) =>
      gateway.chat(requireParams(params, ['message'])),
    'agent.stream': async (params, ctx) => {
      const { message, sessionId } = requireParams(params, ['message']);
      if (typeof ctx?.emit !== 'function') {
        throw rpcError('streaming requires an emit channel', -32603);
      }
      return gateway.streamChat({
        message,
        sessionId,
        streamId: ctx.id ?? crypto.randomUUID(),
        emit: ctx.emit,
      });
    },

    // --- background loops -------------------------------------------------
    'cron.list': async () => gateway.cronLoops(),

    // --- OTA updater ------------------------------------------------------
    'update.check': async () => gateway.checkForUpdates(),
    'update.apply': async ({ version } = {}) => gateway.applyUpdate({ version }),
  };

  return {
    async handle(method, params, ctx) {
      const handler = methods[method];
      if (!handler) throw rpcError(`unknown method: ${method}`, -32601);
      log('debug', `rpc ${method}`, { ctx: ctx?.id });
      return handler(params, ctx);
    },
    list: () => Object.keys(methods),
  };
}

function requireParams(params, keys) {
  for (const key of keys) {
    if (params?.[key] === undefined || params[key] === null) {
      throw rpcError(`missing required param: ${key}`, -32602);
    }
  }
  return params;
}

module.exports = { createRouter, rpcError };
