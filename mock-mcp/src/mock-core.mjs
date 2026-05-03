const SERVICE_NAME = "capacity-risk-booking-control-center-mock-mcp";
const SERVICE_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const BASE_NOW = "2026-05-03T10:30:00Z";
const AREAS = ["NORTH", "SOUTH", "EAST", "WEST"];
const TIME_SLOTS = ["08:00-12:00", "12:00-18:00"];
const CATEGORIES = [
  { code: "FIBER_INSTALL", name: "Fiber Install", activityTypes: ["INSTALL"], skills: ["FIBER_L1", "FIBER_L2"], timeSlots: TIME_SLOTS },
  { code: "REPAIR", name: "Repair", activityTypes: ["REPAIR"], skills: ["FIBER_L1", "COPPER"], timeSlots: TIME_SLOTS },
  { code: "MAINTENANCE", name: "Maintenance", activityTypes: ["MAINTENANCE"], skills: ["FIBER_L1", "SAFETY_CERTIFIED"], timeSlots: TIME_SLOTS },
  { code: "INSPECTION", name: "Inspection", activityTypes: ["INSPECTION"], skills: ["METERING", "SAFETY_CERTIFIED"], timeSlots: TIME_SLOTS },
  { code: "DISCONNECT", name: "Disconnect", activityTypes: ["DISCONNECT"], skills: ["COPPER"], timeSlots: TIME_SLOTS }
];
const SKILLS = ["FIBER_L1", "FIBER_L2", "COPPER", "METERING", "SAFETY_CERTIFIED"];
const VALID_BOOKING_STATUSES = ["open", "closed", "restricted"];
const sseClients = new Map();

class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

let state = createSeedState();

export function resetState() {
  state = createSeedState();
  return getPublicState();
}

export function getPublicState() {
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    generatedAt: BASE_NOW,
    counts: {
      capacityCells: state.cells.length,
      activities: state.activities.length,
      communications: state.communications.length,
      recommendationStates: state.recommendationStates.length,
      auditEvents: state.auditEvents.length
    },
    areas: AREAS,
    capacityCategories: CATEGORIES,
    skills: SKILLS,
    bookingStatuses: VALID_BOOKING_STATUSES
  };
}

export async function handleHttpRequest(request, env = {}) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return responseJson({}, 204);
  }

  if (env.MOCK_MCP_TOKEN) {
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (token !== env.MOCK_MCP_TOKEN) {
      return responseJson({ error: "unauthorized", message: "Missing or invalid bearer token." }, 401);
    }
  }

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return responseJson({ ok: true, service: SERVICE_NAME, version: SERVICE_VERSION, generatedAt: BASE_NOW });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return responseJson({
        service: SERVICE_NAME,
        endpoints: ["GET /health", "GET /sse", "POST /messages", "GET /mcp", "POST /mcp", "GET /tools", "POST /tools/{toolName}", "GET /mock/state", "POST /mock/reset"]
      });
    }

    if (request.method === "GET" && url.pathname === "/tools") {
      return responseJson({ tools: listTools() });
    }

    if (request.method === "GET" && url.pathname === "/mock/state") {
      return responseJson(getPublicState());
    }

    if (request.method === "POST" && url.pathname === "/mock/reset") {
      return responseJson({ reset: true, state: resetState() });
    }

    if (request.method === "GET" && url.pathname === "/mcp") {
      return responseSse([
        {
          event: "endpoint",
          data: {
            jsonrpc: "2.0",
            service: SERVICE_NAME,
            version: SERVICE_VERSION,
            endpoint: "/mcp"
          }
        }
      ]);
    }

    if (request.method === "GET" && url.pathname === "/sse") {
      return responseMcpSse(url, request);
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      const client = sessionId ? sseClients.get(sessionId) : null;
      if (!client) {
        return responseJson({ error: "unknown_session", message: "Unknown or expired SSE session." }, 404);
      }
      const result = await handleMcp(await readJson(request));
      if (result !== null) {
        sendSse(client.controller, "message", result);
      }
      return responseEmpty(202);
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      const result = await handleMcp(await readJson(request));
      if (result === null) return responseEmpty(202);
      return responseJson(result);
    }

    if (request.method === "POST" && url.pathname.startsWith("/tools/")) {
      const toolName = decodeURIComponent(url.pathname.slice("/tools/".length));
      return responseJson(await callTool(toolName, await readJson(request)));
    }

    return responseJson({ error: "not_found", message: `No route for ${request.method} ${url.pathname}` }, 404);
  } catch (error) {
    if (error instanceof ToolError) {
      return responseJson({ error: error.code, message: error.message, details: error.details }, 400);
    }
    return responseJson({ error: "internal_error", message: error.message }, 500);
  }
}

async function handleMcp(payload) {
  if (Array.isArray(payload)) {
    const responses = [];
    for (const request of payload) {
      const response = await handleMcp(request);
      if (response) responses.push(response);
    }
    return responses;
  }

  if (!payload || payload.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: payload?.id ?? null,
      error: { code: -32600, message: "Invalid JSON-RPC 2.0 request." }
    };
  }

  if (payload.method === "notifications/initialized") {
    return null;
  }

  if (payload.method === "initialize") {
    const requestedVersion = payload.params?.protocolVersion;
    return {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      result: {
        protocolVersion: negotiateProtocolVersion(requestedVersion),
        serverInfo: { name: SERVICE_NAME, version: SERVICE_VERSION },
        capabilities: { tools: {} }
      }
    };
  }

  if (payload.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      result: { tools: listTools() }
    };
  }

  if (payload.method === "tools/call") {
    const result = await callTool(payload.params?.name, payload.params?.arguments || {});
    return {
      jsonrpc: "2.0",
      id: payload.id ?? null,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id: payload.id ?? null,
    error: { code: -32601, message: `Unsupported method ${payload.method}` }
  };
}

function negotiateProtocolVersion(requestedVersion) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
    return requestedVersion;
  }
  return "2025-03-26";
}

export async function callTool(name, args = {}) {
  const tool = TOOL_HANDLERS[name];
  if (!tool) {
    throw new ToolError("unknown_tool", `Unknown tool: ${name}`, { supportedTools: Object.keys(TOOL_HANDLERS) });
  }
  return tool(args || {});
}

function listTools() {
  return Object.entries(TOOL_METADATA).map(([name, metadata]) => ({
    name,
    description: metadata.description,
    inputSchema: metadata.inputSchema
  }));
}

const TOOL_METADATA = {
  get_forecast_demand: {
    description: "Return forecasted workload by date, area, category, skill, and slot.",
    inputSchema: filterSchema()
  },
  get_forecast_plan: {
    description: "Return plan, min forecast, expected forecast, max forecast, and variance.",
    inputSchema: filterSchema()
  },
  get_available_capacity: {
    description: "Return available capacity and available resources by date, area, category, and slot.",
    inputSchema: filterSchema()
  },
  get_capacity_categories: {
    description: "Return capacity categories, associated skills, activity types, and time-slot applicability.",
    inputSchema: { type: "object", properties: { capacityCategories: arrayOrString("Category codes to include.") } }
  },
  get_quota: {
    description: "Return quota, used quota, remaining quota, and close/open state.",
    inputSchema: filterSchema()
  },
  get_booking_statuses: {
    description: "Return booking status by date, area, category, and slot.",
    inputSchema: filterSchema()
  },
  get_booking_closing_schedule: {
    description: "Return booking closing schedule rows.",
    inputSchema: filterSchema()
  },
  search_activities: {
    description: "Return activities contributing to load or eligible for movement.",
    inputSchema: filterSchema({ riskId: { type: "string" }, movableOnly: { type: "boolean" }, status: arrayOrString("Activity statuses.") })
  },
  get_skill_coverage: {
    description: "Return skill-specific demand and capacity.",
    inputSchema: filterSchema({ skills: arrayOrString("Skill codes.") })
  },
  get_capacity_heatmap: {
    description: "Return capacity heatmap cells with risk state, root cause, and next action.",
    inputSchema: filterSchema({ limit: { type: "number" }, includeHealthy: { type: "boolean" } })
  },
  analyze_capacity_risk: {
    description: "Return ranked risk queue with recommendations.",
    inputSchema: filterSchema({ limit: { type: "number" }, includeHealthy: { type: "boolean" } })
  },
  recommend_booking_controls: {
    description: "Return quota, close/open, booking status, and closing schedule recommendations.",
    inputSchema: filterSchema({ riskId: { type: "string" } })
  },
  recommend_activity_rebalance: {
    description: "Return movement candidates and target options.",
    inputSchema: filterSchema({ riskId: { type: "string" }, maxCandidates: { type: "number" } })
  },
  update_quota: {
    description: "Mock quota update.",
    inputSchema: mutationSchema({ quotaMinutes: { type: "number" }, reason: { type: "string" }, allowBelowUsed: { type: "boolean" } })
  },
  update_booking_status: {
    description: "Mock booking close, reopen, or restriction.",
    inputSchema: mutationSchema({ bookingStatus: { type: "string", enum: VALID_BOOKING_STATUSES }, reason: { type: "string" } })
  },
  update_booking_closing_schedule: {
    description: "Mock update to closing schedule.",
    inputSchema: mutationSchema({ closeOffsetDays: { type: "number" }, closeTime: { type: "string" }, reason: { type: "string" } })
  },
  bulk_update_booking_controls: {
    description: "Mock date-range quota or booking status update.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "object" } },
        dateRange: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
        areas: arrayOrString("Areas."),
        capacityCategories: arrayOrString("Category codes."),
        timeSlots: arrayOrString("Time slots."),
        quotaMinutes: { type: "number" },
        bookingStatus: { type: "string", enum: VALID_BOOKING_STATUSES },
        reason: { type: "string" }
      }
    }
  },
  apply_recommended_action_bundle: {
    description: "Apply a composed recommendation bundle across quota, booking status, closing schedule, activity movement, and communication actions.",
    inputSchema: {
      type: "object",
      properties: {
        riskId: { type: "string" },
        recommendationIds: arrayOrString("Recommendation IDs being applied."),
        bookingControlItems: { type: "array", items: { type: "object" } },
        activityMoves: { type: "array", items: { type: "object" } },
        communications: { type: "array", items: { type: "object" } },
        applyBookingControls: { type: "boolean" },
        applyActivityMoves: { type: "boolean" },
        sendCommunications: { type: "boolean" },
        reason: { type: "string" }
      }
    }
  },
  move_activities: {
    description: "Mock bulk activity movement.",
    inputSchema: {
      type: "object",
      properties: {
        moves: {
          type: "array",
          items: {
            type: "object",
            properties: {
              activityId: { type: "string" },
              targetDate: { type: "string" },
              targetTimeSlot: { type: "string" },
              targetArea: { type: "string" },
              targetResource: { type: "string" }
            },
            required: ["activityId", "targetDate", "targetTimeSlot"]
          }
        },
        reason: { type: "string" }
      },
      required: ["moves"]
    }
  },
  send_communication: {
    description: "Mock internal communication or approval request.",
    inputSchema: {
      type: "object",
      properties: {
        audience: arrayOrString("Audience names or groups."),
        communicationType: { type: "string" },
        subject: { type: "string" },
        message: { type: "string" },
        riskId: { type: "string" },
        actionIds: arrayOrString("Related action or recommendation IDs.")
      },
      required: ["audience", "communicationType", "subject", "message"]
    }
  },
  update_recommendation_state: {
    description: "Mock snooze, dismiss, accept, exclude, or lock state change.",
    inputSchema: {
      type: "object",
      properties: {
        recommendationId: { type: "string" },
        riskId: { type: "string" },
        activityId: { type: "string" },
        state: { type: "string" },
        until: { type: "string" },
        reason: { type: "string" }
      },
      required: ["state"]
    }
  }
};

const TOOL_HANDLERS = {
  get_forecast_demand: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => pick(cell, ["date", "area", "capacityCategory", "activityType", "timeSlot", "skill", "forecastedWorkloadMinutes", "forecastMinWorkloadMinutes", "forecastMaxWorkloadMinutes"]))
  }),
  get_forecast_plan: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => pick(cell, ["date", "area", "capacityCategory", "activityType", "timeSlot", "skill", "forecastMinWorkloadMinutes", "forecastedWorkloadMinutes", "forecastMaxWorkloadMinutes", "planWorkloadMinutes", "planVarianceMinutes"]))
  }),
  get_available_capacity: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => pick(cell, ["date", "area", "capacityCategory", "timeSlot", "skill", "calendarCapacityMinutes", "availableCapacityMinutes", "availableResourceCount"]))
  }),
  get_capacity_categories: (args) => ({
    generatedAt: BASE_NOW,
    items: filterBy(CATEGORIES, { code: normalizeList(args.capacityCategories) })
  }),
  get_quota: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => pick(cell, ["date", "area", "capacityCategory", "timeSlot", "currentQuotaMinutes", "usedQuotaMinutes", "remainingQuotaMinutes", "quotaState", "bookingStatus"]))
  }),
  get_booking_statuses: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => pick(cell, ["date", "area", "capacityCategory", "timeSlot", "bookingStatus", "openBookingExposureMinutes"]))
  }),
  get_booking_closing_schedule: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => pick(cell, ["date", "area", "capacityCategory", "timeSlot", "closingSchedule"]))
  }),
  search_activities: (args) => {
    const cell = args.riskId ? riskCellById(args.riskId) : null;
    const filters = cell ? cellToFilter(cell) : args;
    let items = filterActivities(filters);
    if (args.movableOnly) items = items.filter(isMovableActivity);
    if (args.status) items = filterBy(items, { status: normalizeList(args.status) });
    return { generatedAt: BASE_NOW, items };
  },
  get_skill_coverage: (args) => {
    const skills = normalizeList(args.skills);
    const cells = filterCells(args).filter((cell) => !skills || skills.includes(cell.skill));
    const byKey = new Map();
    for (const cell of cells) {
      const key = [cell.date, cell.area, cell.capacityCategory, cell.timeSlot, cell.skill].join("|");
      const current = byKey.get(key) || {
        date: cell.date,
        area: cell.area,
        capacityCategory: cell.capacityCategory,
        timeSlot: cell.timeSlot,
        skill: cell.skill,
        demandMinutes: 0,
        capacityMinutes: 0,
        availableResourceCount: 0,
        skillGapMinutes: 0
      };
      current.demandMinutes += cell.forecastedWorkloadMinutes;
      current.capacityMinutes += cell.availableCapacityMinutes;
      current.availableResourceCount += cell.availableResourceCount;
      current.skillGapMinutes = Math.max(0, current.demandMinutes - current.capacityMinutes);
      byKey.set(key, current);
    }
    return { generatedAt: BASE_NOW, items: [...byKey.values()] };
  },
  get_capacity_heatmap: (args) => {
    let items = filterCells(args).map(toHeatmapCell);
    if (!args.includeHealthy) {
      items = items.filter((item) => item.riskState !== "HEALTHY");
    }
    items.sort((a, b) => b.riskScore - a.riskScore || a.date.localeCompare(b.date));
    return {
      generatedAt: BASE_NOW,
      items: items.slice(0, Number(args.limit || items.length))
    };
  },
  analyze_capacity_risk: (args) => {
    const hiddenRiskIds = new Set(
      state.recommendationStates
        .filter((item) => ["dismissed", "snoozed", "accepted"].includes(item.state))
        .map((item) => item.riskId)
        .filter(Boolean)
    );
    let risks = filterCells(args).map(toRiskCard);
    risks = risks.filter((risk) => args.includeHealthy || risk.riskScore >= 40);
    risks = risks.filter((risk) => !hiddenRiskIds.has(risk.riskId));
    risks.sort((a, b) => b.riskScore - a.riskScore || a.dateRange.start.localeCompare(b.dateRange.start));
    return { generatedAt: BASE_NOW, items: risks.slice(0, Number(args.limit || 20)) };
  },
  recommend_booking_controls: (args) => {
    const cell = selectCell(args);
    const risk = toRiskCard(cell);
    const recommendedQuotaMinutes = Math.max(cell.usedQuotaMinutes + 90, Math.min(cell.currentQuotaMinutes, cell.availableCapacityMinutes - 420));
    const recommendedBookingStatus = risk.riskScore >= 70 ? "closed" : risk.riskScore >= 50 ? "restricted" : "open";
    return {
      generatedAt: BASE_NOW,
      recommendationId: `BCR-${hashId(risk.riskId)}`,
      riskId: risk.riskId,
      items: [
        {
          date: cell.date,
          area: cell.area,
          capacityCategory: cell.capacityCategory,
          timeSlot: cell.timeSlot,
          currentQuotaMinutes: cell.currentQuotaMinutes,
          recommendedQuotaMinutes,
          usedQuotaMinutes: cell.usedQuotaMinutes,
          remainingQuotaMinutes: cell.remainingQuotaMinutes,
          currentBookingStatus: cell.bookingStatus,
          recommendedBookingStatus,
          recommendedClosingSchedule: { closeOffsetDays: 2, closeTime: "16:00" },
          scope: "TIME_SLOT",
          reason: risk.rootCause,
          approvalRequired: cell.currentQuotaMinutes - recommendedQuotaMinutes >= 600 || recommendedBookingStatus === "closed"
        }
      ],
      expectedImpact: {
        capacityGapMinutesBefore: risk.capacityGapMinutes,
        capacityGapMinutesAfter: Math.max(0, risk.capacityGapMinutes - Math.max(0, cell.currentQuotaMinutes - recommendedQuotaMinutes)),
        slaRiskCountBefore: risk.slaRiskCount,
        slaRiskCountAfter: Math.max(0, Math.round(risk.slaRiskCount * 0.3)),
        appointmentAvailabilityImpact: recommendedBookingStatus === "closed" ? "-14%" : recommendedBookingStatus === "restricted" ? "-7%" : "0%"
      },
      communicationDraft: {
        subject: `${cell.area} ${cell.capacityCategory} booking control recommendation`,
        message: `Recommend ${recommendedBookingStatus} booking and quota ${recommendedQuotaMinutes} minutes for ${cell.date} ${cell.timeSlot}. ${risk.rootCause}.`
      }
    };
  },
  recommend_activity_rebalance: (args) => {
    const cell = selectCell(args);
    const risk = toRiskCard(cell);
    const candidates = filterActivities(cellToFilter(cell))
      .filter(isMovableActivity)
      .sort((a, b) => a.customerPriority - b.customerPriority || b.slaSlackDays - a.slaSlackDays)
      .slice(0, Number(args.maxCandidates || 12))
      .map((activity, index) => {
        const target = findTargetCell(cell, activity, index);
        return {
          activityId: activity.activityId,
          apptNumber: activity.apptNumber,
          currentDate: activity.currentDate,
          currentArea: activity.currentArea,
          currentTimeSlot: activity.currentTimeSlot,
          currentResource: activity.currentResource,
          activityType: activity.activityType,
          impactedCapacityCategories: activity.impactedCapacityCategories,
          requiredSkill: activity.requiredSkill,
          durationMinutes: activity.durationMinutes,
          status: activity.status,
          slaWindowStart: activity.slaWindowStart,
          slaWindowEnd: activity.slaWindowEnd,
          customerPriority: activity.customerPriority,
          moveRisk: activity.slaSlackDays >= 4 ? "LOW" : "MEDIUM",
          movableReason: activity.slaSlackDays >= 4 ? `Low priority and SLA window has ${activity.slaSlackDays} days remaining` : "Flexible activity with target capacity available",
          recommendedTargetDate: target.date,
          recommendedTargetTimeSlot: target.timeSlot,
          recommendedTargetArea: target.area,
          recommendedTargetResource: target.resourceId,
          targetCapacityState: target.riskState,
          capacityReliefMinutes: activity.durationMinutes,
          effectiveQuotaReliefMinutes: activity.durationMinutes,
          sideEffects: target.riskState === "HEALTHY" ? [] : ["Target remains under watch after move"]
        };
      });
    const relief = sum(candidates, "capacityReliefMinutes");
    return {
      generatedAt: BASE_NOW,
      recommendationId: `ARR-${hashId(risk.riskId)}`,
      riskId: risk.riskId,
      candidates,
      totalCapacityReliefMinutes: relief,
      expectedRiskAfterMove: riskLevelForScore(Math.max(0, risk.riskScore - Math.round((relief / Math.max(1, risk.capacityGapMinutes)) * 30))),
      dispatcherCommunicationDraft: {
        subject: `${cell.area} ${cell.capacityCategory} movement plan`,
        message: `Move ${candidates.length} flexible activities out of ${cell.date} ${cell.timeSlot} to relieve ${relief} capacity minutes.`
      }
    };
  },
  update_quota: (args) => {
    const cells = requireTargetCells(args);
    const updated = [];
    for (const cell of cells) {
      if (Number(args.quotaMinutes) < cell.usedQuotaMinutes && !args.allowBelowUsed) {
        throw new ToolError("quota_below_used", "Quota cannot be reduced below used quota without allowBelowUsed.", {
          date: cell.date,
          area: cell.area,
          capacityCategory: cell.capacityCategory,
          timeSlot: cell.timeSlot,
          usedQuotaMinutes: cell.usedQuotaMinutes
        });
      }
      cell.currentQuotaMinutes = Number(args.quotaMinutes);
      cell.remainingQuotaMinutes = Math.max(0, cell.currentQuotaMinutes - cell.usedQuotaMinutes);
      updated.push(snapshotCell(cell));
    }
    audit("update_quota", args, updated);
    return { updatedCount: updated.length, items: updated };
  },
  update_booking_status: (args) => {
    if (!VALID_BOOKING_STATUSES.includes(args.bookingStatus)) {
      throw new ToolError("invalid_booking_status", `bookingStatus must be one of ${VALID_BOOKING_STATUSES.join(", ")}.`);
    }
    const cells = requireTargetCells(args);
    const updated = cells.map((cell) => {
      cell.bookingStatus = args.bookingStatus;
      cell.quotaState = args.bookingStatus === "closed" ? "closed" : "open";
      cell.openBookingExposureMinutes = args.bookingStatus === "open" ? cell.remainingQuotaMinutes : args.bookingStatus === "restricted" ? Math.round(cell.remainingQuotaMinutes * 0.35) : 0;
      return snapshotCell(cell);
    });
    audit("update_booking_status", args, updated);
    return { updatedCount: updated.length, items: updated };
  },
  update_booking_closing_schedule: (args) => {
    const cells = requireTargetCells(args);
    const updated = cells.map((cell) => {
      cell.closingSchedule = {
        closeOffsetDays: Number(args.closeOffsetDays ?? cell.closingSchedule.closeOffsetDays),
        closeTime: args.closeTime || cell.closingSchedule.closeTime
      };
      return snapshotCell(cell);
    });
    audit("update_booking_closing_schedule", args, updated);
    return { updatedCount: updated.length, items: updated };
  },
  bulk_update_booking_controls: (args) => {
    const items = args.items?.length ? args.items : requireTargetCells(args).map((cell) => ({
      date: cell.date,
      area: cell.area,
      capacityCategory: cell.capacityCategory,
      timeSlot: cell.timeSlot,
      quotaMinutes: args.quotaMinutes,
      bookingStatus: args.bookingStatus,
      reason: args.reason
    }));
    const results = [];
    for (const item of items) {
      if (item.quotaMinutes !== undefined) results.push({ type: "quota", result: TOOL_HANDLERS.update_quota(item) });
      if (item.bookingStatus) results.push({ type: "bookingStatus", result: TOOL_HANDLERS.update_booking_status(item) });
    }
    return { appliedItemCount: items.length, results };
  },
  apply_recommended_action_bundle: (args) => {
    const riskCell = args.riskId ? riskCellById(args.riskId) : null;
    const bookingControlItems = args.bookingControlItems || (
      riskCell && args.applyBookingControls !== false
        ? TOOL_HANDLERS.recommend_booking_controls({ riskId: args.riskId }).items
        : []
    );
    const activityMoves = args.activityMoves || (
      riskCell && args.applyActivityMoves
        ? TOOL_HANDLERS.recommend_activity_rebalance({ riskId: args.riskId }).candidates.map((candidate) => ({
          activityId: candidate.activityId,
          targetDate: candidate.recommendedTargetDate,
          targetTimeSlot: candidate.recommendedTargetTimeSlot,
          targetArea: candidate.recommendedTargetArea,
          targetResource: candidate.recommendedTargetResource
        }))
        : []
    );
    const communications = args.communications || [];
    const results = {
      riskId: args.riskId,
      recommendationIds: normalizeList(args.recommendationIds) || [],
      quotaUpdates: [],
      bookingStatusUpdates: [],
      closingScheduleUpdates: [],
      activityMoveResult: null,
      communications: [],
      stateUpdate: null
    };

    if (args.applyBookingControls !== false) {
      for (const item of bookingControlItems) {
        const target = {
          date: item.date,
          area: item.area,
          capacityCategory: item.capacityCategory,
          timeSlot: item.timeSlot,
          reason: args.reason || item.reason || "Apply recommended booking controls"
        };
        if (item.recommendedQuotaMinutes !== undefined) {
          results.quotaUpdates.push(TOOL_HANDLERS.update_quota({
            ...target,
            quotaMinutes: item.recommendedQuotaMinutes
          }));
        }
        if (item.recommendedBookingStatus) {
          results.bookingStatusUpdates.push(TOOL_HANDLERS.update_booking_status({
            ...target,
            bookingStatus: item.recommendedBookingStatus
          }));
        }
        if (item.recommendedClosingSchedule) {
          results.closingScheduleUpdates.push(TOOL_HANDLERS.update_booking_closing_schedule({
            ...target,
            closeOffsetDays: item.recommendedClosingSchedule.closeOffsetDays,
            closeTime: item.recommendedClosingSchedule.closeTime
          }));
        }
      }
    }

    if (args.applyActivityMoves && activityMoves.length) {
      results.activityMoveResult = TOOL_HANDLERS.move_activities({
        moves: activityMoves,
        reason: args.reason || "Apply recommended activity rebalance"
      });
    }

    if (args.sendCommunications && communications.length) {
      results.communications = communications.map((communication) => TOOL_HANDLERS.send_communication({
        ...communication,
        riskId: communication.riskId || args.riskId
      }));
    }

    if (args.riskId) {
      results.stateUpdate = TOOL_HANDLERS.update_recommendation_state({
        riskId: args.riskId,
        state: "applied",
        reason: args.reason || "Recommended action bundle applied"
      });
    }

    audit("apply_recommended_action_bundle", args, {
      quotaUpdateCount: results.quotaUpdates.length,
      bookingStatusUpdateCount: results.bookingStatusUpdates.length,
      closingScheduleUpdateCount: results.closingScheduleUpdates.length,
      movedCount: results.activityMoveResult?.movedCount || 0,
      communicationCount: results.communications.length
    });

    return {
      appliedAt: BASE_NOW,
      status: "applied",
      ...results
    };
  },
  move_activities: (args) => {
    const moved = [];
    const failed = [];
    for (const move of args.moves || []) {
      const activity = state.activities.find((item) => item.activityId === move.activityId);
      if (!activity) {
        failed.push({ activityId: move.activityId, reason: "Activity not found" });
        continue;
      }
      if (!isMovableActivity(activity)) {
        failed.push({ activityId: move.activityId, reason: "Activity is not movable due to status, SLA, priority, or recommendation lock" });
        continue;
      }
      if (new Date(`${move.targetDate}T23:59:00Z`) > new Date(activity.slaWindowEnd)) {
        failed.push({ activityId: move.activityId, reason: "Target date is outside SLA window" });
        continue;
      }
      const targetCell = state.cells.find((cell) =>
        cell.date === move.targetDate &&
        cell.area === (move.targetArea || activity.currentArea) &&
        cell.timeSlot === move.targetTimeSlot &&
        cell.capacityCategory === activity.impactedCapacityCategories[0]
      );
      if (!targetCell || targetCell.availableCapacityMinutes - targetCell.bookedWorkloadMinutes < activity.durationMinutes) {
        failed.push({ activityId: move.activityId, reason: "Target capacity is not available" });
        continue;
      }
      const sourceCell = state.cells.find((cell) =>
        cell.date === activity.currentDate &&
        cell.area === activity.currentArea &&
        cell.timeSlot === activity.currentTimeSlot &&
        cell.capacityCategory === activity.impactedCapacityCategories[0]
      );
      if (sourceCell) {
        sourceCell.bookedWorkloadMinutes = Math.max(0, sourceCell.bookedWorkloadMinutes - activity.durationMinutes);
        sourceCell.usedQuotaMinutes = Math.max(0, sourceCell.usedQuotaMinutes - activity.durationMinutes);
        sourceCell.remainingQuotaMinutes = Math.max(0, sourceCell.currentQuotaMinutes - sourceCell.usedQuotaMinutes);
      }
      targetCell.bookedWorkloadMinutes += activity.durationMinutes;
      targetCell.usedQuotaMinutes += activity.durationMinutes;
      targetCell.remainingQuotaMinutes = Math.max(0, targetCell.currentQuotaMinutes - targetCell.usedQuotaMinutes);
      activity.currentDate = move.targetDate;
      activity.currentArea = move.targetArea || activity.currentArea;
      activity.currentTimeSlot = move.targetTimeSlot;
      activity.currentResource = move.targetResource || activity.currentResource;
      activity.moveHistory.push({ movedAt: BASE_NOW, reason: args.reason || "Mock rebalance", target: move });
      moved.push(activity);
    }
    audit("move_activities", args, { movedCount: moved.length, failedCount: failed.length });
    return { movedCount: moved.length, failedCount: failed.length, moved, failed };
  },
  send_communication: (args) => {
    const communication = {
      communicationId: `COMM-${String(state.communications.length + 1).padStart(5, "0")}`,
      sentAt: BASE_NOW,
      audience: normalizeList(args.audience) || [],
      communicationType: args.communicationType,
      subject: args.subject,
      message: args.message,
      riskId: args.riskId,
      actionIds: normalizeList(args.actionIds) || [],
      status: "sent"
    };
    state.communications.push(communication);
    audit("send_communication", args, communication);
    return communication;
  },
  update_recommendation_state: (args) => {
    const record = {
      stateId: `STATE-${String(state.recommendationStates.length + 1).padStart(5, "0")}`,
      updatedAt: BASE_NOW,
      recommendationId: args.recommendationId,
      riskId: args.riskId,
      activityId: args.activityId,
      state: args.state,
      until: args.until,
      reason: args.reason || ""
    };
    state.recommendationStates.push(record);
    audit("update_recommendation_state", args, record);
    return record;
  }
};

function createSeedState() {
  const dates = Array.from({ length: 30 }, (_, index) => addDays("2026-05-12", index));
  const cells = [];
  for (const [dateIndex, date] of dates.entries()) {
    for (const [areaIndex, area] of AREAS.entries()) {
      for (const [categoryIndex, category] of CATEGORIES.entries()) {
        for (const [slotIndex, timeSlot] of TIME_SLOTS.entries()) {
          const skill = category.skills[(areaIndex + slotIndex) % category.skills.length];
          const plan = 2520 + categoryIndex * 360 + areaIndex * 180 + slotIndex * 240;
          const variation = ((dateIndex % 5) - 2) * 120;
          const expected = plan + variation + (dateIndex % 7 === categoryIndex ? 360 : 0);
          const available = plan - 120 + ((areaIndex + dateIndex) % 4) * 150;
          const used = Math.round(expected * 0.68);
          const quota = Math.max(used + 360, plan + 240);
          cells.push({
            date,
            area,
            capacityCategory: category.code,
            activityType: category.activityTypes[0],
            timeSlot,
            skill,
            forecastMinWorkloadMinutes: Math.max(0, expected - 420),
            forecastedWorkloadMinutes: expected,
            forecastMaxWorkloadMinutes: expected + 420,
            planWorkloadMinutes: plan,
            planVarianceMinutes: expected - plan,
            calendarCapacityMinutes: available + 720,
            availableCapacityMinutes: available,
            availableResourceCount: Math.max(4, Math.round(available / 330)),
            bookedWorkloadMinutes: used,
            currentQuotaMinutes: quota,
            usedQuotaMinutes: used,
            remainingQuotaMinutes: quota - used,
            quotaState: "open",
            bookingStatus: "open",
            openBookingExposureMinutes: quota - used,
            totalActivityCount: Math.max(8, Math.round(used / 120)),
            slaRiskCount: Math.max(0, Math.round(Math.max(0, expected - available) / 120)),
            movableActivityCount: 0,
            closingSchedule: { closeOffsetDays: 1, closeTime: "17:00" },
            managementMode: "QUOTA_BASED"
          });
        }
      }
    }
  }

  applyRiskOverride(cells, {
    date: "2026-05-14",
    area: "NORTH",
    capacityCategory: "FIBER_INSTALL",
    timeSlot: "08:00-12:00",
    skill: "FIBER_L2",
    forecastMinWorkloadMinutes: 6120,
    forecastedWorkloadMinutes: 6840,
    forecastMaxWorkloadMinutes: 7560,
    planWorkloadMinutes: 6000,
    availableCapacityMinutes: 5220,
    availableResourceCount: 16,
    bookedWorkloadMinutes: 4710,
    currentQuotaMinutes: 6000,
    usedQuotaMinutes: 4710,
    bookingStatus: "open",
    openBookingExposureMinutes: 1290,
    totalActivityCount: 44,
    slaRiskCount: 31,
    movableActivityCount: 12
  });
  applyRiskOverride(cells, {
    date: "2026-05-16",
    area: "SOUTH",
    capacityCategory: "REPAIR",
    timeSlot: "12:00-18:00",
    forecastedWorkloadMinutes: 5520,
    planWorkloadMinutes: 4320,
    availableCapacityMinutes: 3900,
    currentQuotaMinutes: 5400,
    usedQuotaMinutes: 4020,
    openBookingExposureMinutes: 1380,
    slaRiskCount: 24,
    movableActivityCount: 6
  });
  applyRiskOverride(cells, {
    date: "2026-05-18",
    area: "EAST",
    capacityCategory: "INSPECTION",
    timeSlot: "08:00-12:00",
    forecastedWorkloadMinutes: 4380,
    planWorkloadMinutes: 3720,
    availableCapacityMinutes: 3180,
    currentQuotaMinutes: 4200,
    usedQuotaMinutes: 3000,
    openBookingExposureMinutes: 1200,
    slaRiskCount: 18,
    movableActivityCount: 8
  });
  applyRiskOverride(cells, {
    date: "2026-05-20",
    area: "WEST",
    capacityCategory: "MAINTENANCE",
    timeSlot: "12:00-18:00",
    forecastedWorkloadMinutes: 5160,
    planWorkloadMinutes: 3840,
    availableCapacityMinutes: 4020,
    currentQuotaMinutes: 4800,
    usedQuotaMinutes: 3960,
    openBookingExposureMinutes: 840,
    slaRiskCount: 15,
    movableActivityCount: 10
  });

  for (const cell of cells) {
    cell.planVarianceMinutes = cell.forecastedWorkloadMinutes - cell.planWorkloadMinutes;
    if (!cell.forecastMinWorkloadMinutes || cell.forecastMinWorkloadMinutes >= cell.forecastedWorkloadMinutes) {
      cell.forecastMinWorkloadMinutes = Math.max(0, cell.forecastedWorkloadMinutes - 420);
    }
    if (!cell.forecastMaxWorkloadMinutes || cell.forecastMaxWorkloadMinutes <= cell.forecastedWorkloadMinutes) {
      cell.forecastMaxWorkloadMinutes = cell.forecastedWorkloadMinutes + 420;
    }
    cell.calendarCapacityMinutes = Math.max(cell.calendarCapacityMinutes, cell.availableCapacityMinutes + 480);
    cell.remainingQuotaMinutes = Math.max(0, cell.currentQuotaMinutes - cell.usedQuotaMinutes);
    if (cell.bookingStatus === "closed") cell.openBookingExposureMinutes = 0;
  }

  const activities = createActivities(cells);
  return { cells, activities, communications: [], recommendationStates: [], auditEvents: [] };
}

function createActivities(cells) {
  const activities = [];
  let sequence = 10001;
  const focusCell = cells.find((cell) => cell.date === "2026-05-14" && cell.area === "NORTH" && cell.capacityCategory === "FIBER_INSTALL" && cell.timeSlot === "08:00-12:00");
  for (let index = 0; index < 12; index += 1) {
    activities.push(createActivity(sequence++, focusCell, {
      activityType: index % 3 === 0 ? "MAINTENANCE" : "INSTALL",
      requiredSkill: index % 2 === 0 ? "FIBER_L1" : "FIBER_L2",
      durationMinutes: index % 2 === 0 ? 90 : 120,
      customerPriority: index < 9 ? 2 : 4,
      slaSlackDays: 6 - (index % 3),
      movable: true
    }));
  }

  for (const cell of cells.filter((item, index) => index % 5 === 0).slice(0, 220)) {
    const count = cell.slaRiskCount > 10 ? 4 : 2;
    for (let index = 0; index < count; index += 1) {
      activities.push(createActivity(sequence++, cell, {
        durationMinutes: 60 + ((sequence + index) % 3) * 30,
        customerPriority: 1 + ((sequence + index) % 5),
        slaSlackDays: 2 + ((sequence + index) % 6),
        movable: index % 2 === 0
      }));
    }
  }
  return activities;
}

function createActivity(sequence, cell, overrides = {}) {
  const slaSlackDays = overrides.slaSlackDays ?? 4;
  return {
    activityId: `A-${sequence}`,
    apptNumber: `APPT-${sequence}`,
    currentDate: cell.date,
    currentArea: cell.area,
    currentTimeSlot: cell.timeSlot,
    currentResource: `RES-${String((sequence % 40) + 1).padStart(3, "0")}`,
    activityType: overrides.activityType || cell.activityType,
    impactedCapacityCategories: [cell.capacityCategory, ...(cell.capacityCategory === "FIBER_INSTALL" ? ["MAINTENANCE"] : [])],
    requiredSkill: overrides.requiredSkill || cell.skill,
    durationMinutes: overrides.durationMinutes || 90,
    status: overrides.status || "pending",
    slaWindowStart: `${cell.date}T08:00:00Z`,
    slaWindowEnd: `${addDays(cell.date, slaSlackDays)}T17:00:00Z`,
    customerPriority: overrides.customerPriority || 3,
    slaSlackDays,
    movable: overrides.movable ?? true,
    moveHistory: []
  };
}

function applyRiskOverride(cells, patch) {
  const cell = cells.find((item) =>
    item.date === patch.date &&
    item.area === patch.area &&
    item.capacityCategory === patch.capacityCategory &&
    item.timeSlot === patch.timeSlot
  );
  Object.assign(cell, patch);
}

function filterCells(args = {}) {
  const filters = expandDateRange(args);
  return filterBy(state.cells, {
    date: normalizeList(filters.dates || filters.date),
    area: normalizeList(filters.areas || filters.area),
    capacityCategory: normalizeList(filters.capacityCategories || filters.capacityCategory),
    activityType: normalizeList(filters.activityTypes || filters.activityType),
    timeSlot: normalizeList(filters.timeSlots || filters.timeSlot),
    skill: normalizeList(filters.skills || filters.skill)
  });
}

function filterActivities(args = {}) {
  const filters = expandDateRange(args);
  return state.activities.filter((activity) =>
    matchList(activity.currentDate, normalizeList(filters.dates || filters.currentDates || filters.date)) &&
    matchList(activity.currentArea, normalizeList(filters.areas || filters.currentAreas || filters.area)) &&
    matchList(activity.currentTimeSlot, normalizeList(filters.timeSlots || filters.currentTimeSlot || filters.timeSlot)) &&
    matchAny(activity.impactedCapacityCategories, normalizeList(filters.capacityCategories || filters.capacityCategory)) &&
    matchList(activity.activityType, normalizeList(filters.activityTypes || filters.activityType)) &&
    matchList(activity.requiredSkill, normalizeList(filters.skills || filters.skill))
  );
}

function filterBy(items, filters, aliases = {}) {
  return items.filter((item) => Object.entries(filters).every(([key, values]) => {
    if (!values) return true;
    const itemKey = aliases[key] || key;
    return matchList(item[itemKey], values);
  }));
}

function expandDateRange(args) {
  if (!args.dateRange?.start || !args.dateRange?.end) return args;
  return {
    ...args,
    dates: dateRange(args.dateRange.start, args.dateRange.end)
  };
}

function selectCell(args) {
  if (args.riskId) return riskCellById(args.riskId);
  const cells = filterCells(args);
  if (!cells.length) throw new ToolError("target_not_found", "No matching capacity cell found.", args);
  return cells.map(toRiskPair).sort((a, b) => b.risk.riskScore - a.risk.riskScore)[0].cell;
}

function riskCellById(riskId) {
  const cell = state.cells.find((candidate) => toRiskCard(candidate).riskId === riskId);
  if (!cell) throw new ToolError("risk_not_found", `No risk found for ${riskId}.`);
  return cell;
}

function requireTargetCells(args) {
  const cells = filterCells(args);
  if (!cells.length) throw new ToolError("target_not_found", "No matching target rows found.", args);
  return cells;
}

function toRiskPair(cell) {
  return { cell, risk: toRiskCard(cell) };
}

function toRiskCard(cell) {
  const score = riskScore(cell);
  const capacityGapMinutes = Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes);
  const categoryName = CATEGORIES.find((category) => category.code === cell.capacityCategory)?.name || cell.capacityCategory;
  return {
    riskId: riskIdForCell(cell),
    title: `${cell.area} ${categoryName} capacity risk`,
    riskLevel: riskLevelForScore(score),
    riskScore: score,
    dateRange: { start: cell.date, end: cell.date },
    area: cell.area,
    capacityCategory: cell.capacityCategory,
    activityType: cell.activityType,
    timeSlot: cell.timeSlot,
    requiredSkill: cell.skill,
    forecastedWorkloadMinutes: cell.forecastedWorkloadMinutes,
    forecastMinWorkloadMinutes: cell.forecastMinWorkloadMinutes,
    forecastMaxWorkloadMinutes: cell.forecastMaxWorkloadMinutes,
    planWorkloadMinutes: cell.planWorkloadMinutes,
    planVarianceMinutes: cell.planVarianceMinutes,
    availableCapacityMinutes: cell.availableCapacityMinutes,
    availableResourceCount: cell.availableResourceCount,
    capacityGapMinutes,
    currentQuotaMinutes: cell.currentQuotaMinutes,
    usedQuotaMinutes: cell.usedQuotaMinutes,
    remainingQuotaMinutes: cell.remainingQuotaMinutes,
    bookingStatus: cell.bookingStatus,
    openBookingExposureMinutes: cell.openBookingExposureMinutes,
    slaRiskCount: cell.slaRiskCount,
    movableActivityCount: Math.max(cell.movableActivityCount, filterActivities(cellToFilter(cell)).filter(isMovableActivity).length),
    rootCause: rootCause(cell),
    managementMode: cell.managementMode,
    recommendedActionSummary: recommendedAction(cell, score),
    expectedImpactSummary: expectedImpact(cell),
    confidence: Number(Math.min(0.92, 0.68 + score / 400).toFixed(2)),
    lastRefreshedAt: BASE_NOW
  };
}

function toHeatmapCell(cell) {
  const score = riskScore(cell);
  const capacityGapMinutes = Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes);
  const utilization = Number((cell.forecastedWorkloadMinutes / Math.max(1, cell.availableCapacityMinutes)).toFixed(2));
  return {
    date: cell.date,
    area: cell.area,
    capacityCategory: cell.capacityCategory,
    activityType: cell.activityType,
    timeSlot: cell.timeSlot,
    skill: cell.skill,
    forecastedWorkloadMinutes: cell.forecastedWorkloadMinutes,
    forecastMinWorkloadMinutes: cell.forecastMinWorkloadMinutes,
    forecastMaxWorkloadMinutes: cell.forecastMaxWorkloadMinutes,
    planWorkloadMinutes: cell.planWorkloadMinutes,
    planVarianceMinutes: cell.planVarianceMinutes,
    calendarCapacityMinutes: cell.calendarCapacityMinutes,
    availableCapacityMinutes: cell.availableCapacityMinutes,
    availableResourceCount: cell.availableResourceCount,
    bookedWorkloadMinutes: cell.bookedWorkloadMinutes,
    currentQuotaMinutes: cell.currentQuotaMinutes,
    usedQuotaMinutes: cell.usedQuotaMinutes,
    remainingQuotaMinutes: cell.remainingQuotaMinutes,
    capacityGapMinutes,
    utilization,
    bookingStatus: cell.bookingStatus,
    managementMode: cell.managementMode,
    riskScore: score,
    riskState: riskLevelForScore(score),
    rootCauseTag: rootCause(cell),
    recommendedNextAction: recommendedNextAction(cell, score),
    riskId: riskIdForCell(cell)
  };
}

function riskScore(cell) {
  const workloadCapacityGapRatio = Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes) / Math.max(1, cell.forecastedWorkloadMinutes);
  const quotaExposureRatio = Math.max(0, cell.currentQuotaMinutes - cell.availableCapacityMinutes) / Math.max(1, cell.currentQuotaMinutes);
  const bookingExposureRatio = cell.openBookingExposureMinutes / Math.max(1, cell.availableCapacityMinutes);
  const slaExposureRatio = cell.slaRiskCount / Math.max(1, cell.totalActivityCount);
  const skillScarcityRatio = Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes) / Math.max(1, cell.forecastedWorkloadMinutes);
  const forecastPlanVarianceRatio = Math.max(0, cell.forecastedWorkloadMinutes - cell.planWorkloadMinutes) / Math.max(1, cell.planWorkloadMinutes);
  const rawScore =
    25 * workloadCapacityGapRatio +
    20 * quotaExposureRatio +
    20 * bookingExposureRatio +
    15 * slaExposureRatio +
    10 * skillScarcityRatio +
    10 * forecastPlanVarianceRatio;
  return Math.min(100, Math.round(rawScore * 3.4));
}

function riskLevelForScore(score) {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "AT_RISK";
  if (score >= 40) return "WATCH";
  return "HEALTHY";
}

function rootCause(cell) {
  const causes = [];
  if (cell.forecastedWorkloadMinutes > cell.availableCapacityMinutes) causes.push("skill-specific capacity gap");
  if (cell.currentQuotaMinutes > cell.availableCapacityMinutes) causes.push("quota above available capacity");
  if (cell.bookingStatus === "open" && cell.openBookingExposureMinutes > 0) causes.push("booking still open");
  if (cell.forecastedWorkloadMinutes > cell.planWorkloadMinutes) causes.push("forecast above plan");
  return causes.length ? sentenceCase(causes.join(" with ")) : "Capacity, quota, and booking posture are aligned";
}

function recommendedAction(cell, score) {
  if (score >= 70 && cell.movableActivityCount > 0) return "Reduce quota, close or restrict booking, and move flexible activities";
  if (score >= 50) return "Restrict booking and review quota";
  return "Monitor and refresh";
}

function recommendedNextAction(cell, score) {
  if (score >= 70 && cell.movableActivityCount > 0) return "Generate booking controls and activity rebalance";
  if (score >= 70) return "Generate booking controls";
  if (score >= 50 && cell.bookingStatus === "open") return "Restrict booking slot";
  if (cell.forecastedWorkloadMinutes > cell.planWorkloadMinutes) return "Review forecast plan variance";
  return "Monitor";
}

function expectedImpact(cell) {
  const movableRelief = Math.min(cell.movableActivityCount * 90, Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes));
  return `Potentially relieves ${movableRelief} minutes and reduces SLA-risk jobs from ${cell.slaRiskCount} to ${Math.max(0, Math.round(cell.slaRiskCount * 0.35))}`;
}

function findTargetCell(sourceCell, activity, index) {
  const candidates = state.cells
    .filter((cell) =>
      cell.date > sourceCell.date &&
      cell.area === sourceCell.area &&
      cell.capacityCategory === activity.impactedCapacityCategories[0] &&
      cell.timeSlot !== sourceCell.timeSlot &&
      cell.availableCapacityMinutes - cell.bookedWorkloadMinutes > activity.durationMinutes
    )
    .map(toRiskPair)
    .sort((a, b) => a.risk.riskScore - b.risk.riskScore);
  const selected = candidates[index % Math.max(1, candidates.length)]?.cell || sourceCell;
  return {
    date: selected.date,
    area: selected.area,
    timeSlot: selected.timeSlot,
    riskState: riskLevelForScore(riskScore(selected)),
    resourceId: `RES-${String((index % 40) + 1).padStart(3, "0")}`
  };
}

function isMovableActivity(activity) {
  const locked = state.recommendationStates.some((item) => item.activityId === activity.activityId && ["excluded", "locked"].includes(item.state));
  return activity.movable && !locked && ["pending", "scheduled"].includes(activity.status) && activity.customerPriority <= 3 && activity.slaSlackDays >= 2;
}

function snapshotCell(cell) {
  return pick(cell, ["date", "area", "capacityCategory", "timeSlot", "currentQuotaMinutes", "usedQuotaMinutes", "remainingQuotaMinutes", "bookingStatus", "openBookingExposureMinutes", "closingSchedule"]);
}

function cellToFilter(cell) {
  return {
    dates: [cell.date],
    areas: [cell.area],
    capacityCategories: [cell.capacityCategory],
    timeSlots: [cell.timeSlot]
  };
}

function riskIdForCell(cell) {
  return `RISK-${cell.date}-${cell.area}-${cell.capacityCategory}-${cell.timeSlot.replace(/[:]/g, "").replace("-", "")}`;
}

function audit(toolName, input, result) {
  state.auditEvents.push({
    auditId: `AUDIT-${String(state.auditEvents.length + 1).padStart(5, "0")}`,
    occurredAt: BASE_NOW,
    toolName,
    input,
    resultSummary: Array.isArray(result) ? { count: result.length } : result
  });
}

async function readJson(request) {
  if (!request.body) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError("invalid_json", "Request body must be valid JSON.");
  }
}

function responseJson(payload, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version,mcp-method,mcp-name,last-event-id",
      "access-control-expose-headers": "mcp-session-id"
    }
  });
}

function responseEmpty(status = 202) {
  return new Response(null, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version,mcp-method,mcp-name,last-event-id",
      "access-control-expose-headers": "mcp-session-id"
    }
  });
}

function responseSse(events, status = 200) {
  const body = events
    .map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`)
    .join("");
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version,mcp-method,mcp-name,last-event-id",
      "access-control-expose-headers": "mcp-session-id"
    }
  });
}

function responseMcpSse(url, request) {
  const sessionId = `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(/:$/, "") || "https";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  const origin = `${proto}://${host}`;
  const messagePath = `/messages?sessionId=${encodeURIComponent(sessionId)}`;
  const messageEndpoint = `${origin}${messagePath}`;

  const stream = new ReadableStream({
    start(controller) {
      const client = { controller, heartbeat: null, expiry: null };
      sseClients.set(sessionId, client);
      sendSse(controller, "endpoint", messageEndpoint);
      client.heartbeat = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        } catch {
          cleanupSseClient(sessionId);
        }
      }, 15000);
      client.expiry = setTimeout(() => {
        cleanupSseClient(sessionId);
        try {
          controller.close();
        } catch {
          // Client already disconnected.
        }
      }, 5 * 60 * 1000);
    },
    cancel() {
      cleanupSseClient(sessionId);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "authorization,content-type,accept,mcp-session-id,mcp-protocol-version,mcp-method,mcp-name,last-event-id",
      "access-control-expose-headers": "mcp-session-id",
      "x-accel-buffering": "no",
      "mcp-session-id": sessionId,
      "x-mcp-message-endpoint": messageEndpoint
    }
  });
}

function sendSse(controller, event, data) {
  controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`));
}

function cleanupSseClient(sessionId) {
  const client = sseClients.get(sessionId);
  if (!client) return;
  if (client.heartbeat) clearInterval(client.heartbeat);
  if (client.expiry) clearTimeout(client.expiry);
  sseClients.delete(sessionId);
}

function filterSchema(extra = {}) {
  return {
    type: "object",
    properties: {
      dates: arrayOrString("ISO dates."),
      dateRange: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
      areas: arrayOrString("Capacity areas."),
      capacityCategories: arrayOrString("Capacity category codes."),
      activityTypes: arrayOrString("Activity type codes."),
      timeSlots: arrayOrString("Time slots."),
      skills: arrayOrString("Skill codes."),
      ...extra
    }
  };
}

function mutationSchema(extra = {}) {
  return {
    type: "object",
    properties: {
      date: { type: "string" },
      dates: arrayOrString("ISO dates."),
      dateRange: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
      area: { type: "string" },
      areas: arrayOrString("Capacity areas."),
      capacityCategory: { type: "string" },
      capacityCategories: arrayOrString("Capacity category codes."),
      timeSlot: { type: "string" },
      timeSlots: arrayOrString("Time slots."),
      ...extra
    }
  };
}

function arrayOrString(description) {
  return {
    oneOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
    description
  };
}

function normalizeList(value) {
  if (value === undefined || value === null || value === "") return null;
  return Array.isArray(value) ? value : [value];
}

function matchList(value, allowed) {
  return !allowed || allowed.includes(value);
}

function matchAny(values, allowed) {
  return !allowed || values.some((value) => allowed.includes(value));
}

function dateRange(start, end) {
  const dates = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function addDays(date, days) {
  const cursor = new Date(`${date}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return cursor.toISOString().slice(0, 10);
}

function pick(item, keys) {
  return Object.fromEntries(keys.map((key) => [key, item[key]]));
}

function sum(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function hashId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 100000;
  }
  return String(hash).padStart(5, "0");
}

function sentenceCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
