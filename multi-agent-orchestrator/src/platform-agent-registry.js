const ALLOWED_EFFECTS = new Set(["read_only", "planning", "device_action"]);

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function clone(value) {
  return structuredClone(value);
}

/** Explicit platform allowlist for Agents and the capabilities they expose. */
export class PlatformAgentRegistry {
  constructor({ agents = [] } = {}) {
    this.agents = new Map();
    for (const agent of agents) this.registerAgent(agent);
  }

  registerAgent({ agent_id, name, description = "", capabilities, invoke } = {}) {
    const agentId = requireText(agent_id, "agent_id");
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agentId)) throw new Error("agent_id may contain only letters, digits, dot, underscore, and hyphen");
    if (this.agents.has(agentId)) throw new Error(`Agent already registered: ${agentId}`);
    if (typeof invoke !== "function") throw new Error(`Agent ${agentId} must have an invoke function`);
    if (!Array.isArray(capabilities) || capabilities.length === 0) {
      throw new Error(`Agent ${agentId} must declare at least one capability`);
    }

    const capabilityMap = new Map();
    for (const capability of capabilities) {
      const capabilityName = requireText(capability?.name, `${agentId}.capabilities[].name`);
      if (capabilityName.length > 128) throw new Error(`Capability name is too long for ${agentId}`);
      const effect = capability?.effect ?? "read_only";
      if (!ALLOWED_EFFECTS.has(effect)) throw new Error(`Unsupported capability effect: ${effect}`);
      if (effect === "device_action" && agentId !== "device-manager") {
        const error = new Error("Only device-manager may register a device_action capability");
        error.code = "DEVICE_ACTION_AGENT_FORBIDDEN";
        throw error;
      }
      if (capabilityMap.has(capabilityName)) throw new Error(`Duplicate capability ${capabilityName} for ${agentId}`);
      capabilityMap.set(capabilityName, {
        name: capabilityName,
        description: typeof capability.description === "string" ? capability.description.trim() : "",
        effect,
      });
    }

    this.agents.set(agentId, {
      agent_id: agentId,
      name: typeof name === "string" && name.trim() ? name.trim() : agentId,
      description: typeof description === "string" ? description.trim() : "",
      capabilities: capabilityMap,
      invoke,
    });
    return { success: true, agent_id: agentId };
  }

  getAgent(agentId) {
    return this.agents.get(agentId) ?? null;
  }

  getCapability(agentId, capabilityName) {
    return this.agents.get(agentId)?.capabilities.get(capabilityName) ?? null;
  }

  listAgents() {
    return [...this.agents.values()].map((agent) => ({
      agent_id: agent.agent_id,
      name: agent.name,
      description: agent.description,
      capabilities: [...agent.capabilities.values()].map(clone),
    }));
  }
}

export const PLATFORM_AGENT_EFFECTS = Object.freeze([...ALLOWED_EFFECTS]);
