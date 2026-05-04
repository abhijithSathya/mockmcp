const SERVICE_NAME = "capacity-risk-booking-control-center-mock-mcp";
const SERVICE_VERSION = "0.1.0";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const BASE_NOW = "2026-05-03T10:30:00Z";
const AREAS = ["NORTH", "SOUTH", "EAST", "WEST"];
const AREA_GEOGRAPHY = {
  NORTH: { country: "United States", region: "Northeast", district: "Boston District", workZone: "NORTH" },
  SOUTH: { country: "United States", region: "Southeast", district: "Atlanta District", workZone: "SOUTH" },
  EAST: { country: "United States", region: "Mid-Atlantic", district: "Newark District", workZone: "EAST" },
  WEST: { country: "United States", region: "West", district: "Bay Area District", workZone: "WEST" }
};
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
const mcpEvents = [];

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
      knownEvents: state.knownEvents.length,
      workforceScenarios: state.workforceScenarios.length,
      reviewPackages: state.reviewPackages.length,
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
  const acceptHeader = request.headers.get("accept") || "";

  recordMcpEvent("http.request", {
    method: request.method,
    path: url.pathname,
    accept: acceptHeader,
    userAgent: request.headers.get("user-agent")
  });

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

    if (request.method === "GET" && url.pathname === "/" && acceptHeader.includes("text/event-stream")) {
      recordMcpEvent("sse.open", {
        path: url.pathname,
        accept: acceptHeader,
        userAgent: request.headers.get("user-agent")
      });
      return responseMcpSse(url, request);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return responseJson({
        service: SERVICE_NAME,
        endpoints: ["GET /health", "GET /sse", "POST /messages", "GET /mcp", "POST /mcp", "GET /tools", "POST /tools/{toolName}", "GET /mock/state", "GET /mock/mcp-events", "POST /mock/reset"]
      });
    }

    if (request.method === "GET" && url.pathname === "/tools") {
      return responseJson({ tools: listTools() });
    }

    if (request.method === "GET" && url.pathname === "/mock/state") {
      return responseJson(getPublicState());
    }

    if (request.method === "GET" && url.pathname === "/mock/mcp-events") {
      return responseJson({ events: mcpEvents.slice(-100) });
    }

    if (request.method === "POST" && url.pathname === "/mock/reset") {
      mcpEvents.length = 0;
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

    if (request.method === "GET" && ["/sse", "/sse/sse", "/mcp/sse"].includes(url.pathname)) {
      recordMcpEvent("sse.open", {
        path: url.pathname,
        accept: request.headers.get("accept"),
        userAgent: request.headers.get("user-agent")
      });
      return responseMcpSse(url, request);
    }

    if (request.method === "POST" && url.pathname === "/messages") {
      const sessionId = url.searchParams.get("sessionId");
      const client = sessionId ? sseClients.get(sessionId) : null;
      const payload = await readJson(request);
      recordMcpEvent("sse.message.received", {
        sessionId,
        foundSession: Boolean(client),
        method: Array.isArray(payload) ? payload.map((item) => item?.method) : payload?.method,
        id: Array.isArray(payload) ? payload.map((item) => item?.id) : payload?.id,
        userAgent: request.headers.get("user-agent")
      });
      if (!client) {
        recordMcpEvent("sse.message.unknownSession", { sessionId });
        return responseJson({ error: "unknown_session", message: "Unknown or expired SSE session." }, 404);
      }
      const result = await handleMcp(payload);
      if (result !== null) {
        sendSse(client.controller, "message", result);
        recordMcpEvent("sse.message.sent", {
          sessionId,
          method: Array.isArray(payload) ? payload.map((item) => item?.method) : payload?.method,
          id: Array.isArray(payload) ? payload.map((item) => item?.id) : payload?.id
        });
      } else {
        recordMcpEvent("sse.notification.accepted", { sessionId, method: payload?.method });
      }
      return responseEmpty(202);
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      const payload = await readJson(request);
      recordMcpEvent("streamable.message.received", {
        method: Array.isArray(payload) ? payload.map((item) => item?.method) : payload?.method,
        id: Array.isArray(payload) ? payload.map((item) => item?.id) : payload?.id,
        userAgent: request.headers.get("user-agent")
      });
      const result = await handleMcp(payload);
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
  },
  get_forecast_summary: {
    description: "Return high-level forecast workforce KPIs for the Forecast Command Center.",
    inputSchema: filterSchema()
  },
  get_forecast_workload_series: {
    description: "Return chart-ready actual, forecast, plan, booked workload, and capacity series.",
    inputSchema: filterSchema({ granularity: { type: "string", enum: ["day", "week"] } })
  },
  get_forecast_geography_outlook: {
    description: "Return map and geography outlook rows by country, region, district, work zone, or area.",
    inputSchema: filterSchema({ geoLevel: { type: "string", enum: ["country", "region", "district", "workZone", "area"] }, includeSurplus: { type: "boolean" } })
  },
  get_capacity_outlook: {
    description: "Return workforce capacity outlook by date, area, category, skill, and slot.",
    inputSchema: filterSchema()
  },
  get_demand_pattern_detail: {
    description: "Return drilldown data for a selected demand pattern or forecast recommendation.",
    inputSchema: filterSchema({ patternId: { type: "string" }, recommendationId: { type: "string" } })
  },
  get_known_events: {
    description: "List known events, recurrences, and forecast adjustment state.",
    inputSchema: filterSchema({ eventIds: arrayOrString("Known event IDs."), status: arrayOrString("Event adjustment states.") })
  },
  get_workforce_scenario: {
    description: "Return a saved workforce scenario and before/after metrics.",
    inputSchema: { type: "object", properties: { scenarioId: { type: "string" } }, required: ["scenarioId"] }
  },
  get_workforce_review_packages: {
    description: "List saved review packages and applied mock scenario state.",
    inputSchema: filterSchema({ reviewPackageId: { type: "string" }, status: arrayOrString("Package statuses.") })
  },
  analyze_forecast_workforce_recommendations: {
    description: "Return ranked forecast-driven workforce, event, booking, and investigation recommendations.",
    inputSchema: filterSchema({ limit: { type: "number" }, includeHealthy: { type: "boolean" } })
  },
  detect_demand_patterns: {
    description: "Detect forecast spikes, drops, forecast misses, recurring events, and data-quality patterns.",
    inputSchema: filterSchema({ limit: { type: "number" }, sensitivity: { type: "string", enum: ["low", "medium", "high"] } })
  },
  explain_demand_pattern: {
    description: "Explain one demand pattern and suggest likely business drivers.",
    inputSchema: filterSchema({ patternId: { type: "string" } })
  },
  recommend_workforce_actions: {
    description: "Recommend add, release, redeploy, contractor, overtime, and quota options.",
    inputSchema: filterSchema({ recommendationId: { type: "string" }, patternId: { type: "string" } })
  },
  recommend_forecast_booking_controls: {
    description: "Recommend quota and booking controls from forecast workforce context.",
    inputSchema: filterSchema({ recommendationId: { type: "string" }, scenarioId: { type: "string" } })
  },
  simulate_workforce_scenario: {
    description: "Calculate before/after forecast and capacity metrics for workforce and forecast-event actions.",
    inputSchema: {
      type: "object",
      properties: {
        recommendationId: { type: "string" },
        scenarioName: { type: "string" },
        dateRange: { type: "object", properties: { start: { type: "string" }, end: { type: "string" } } },
        areas: arrayOrString("Capacity areas."),
        capacityCategories: arrayOrString("Category codes."),
        skills: arrayOrString("Skill codes."),
        timeSlots: arrayOrString("Time slots."),
        scenarioActions: { type: "array", items: { type: "object" } },
        save: { type: "boolean" }
      }
    }
  },
  compare_workforce_scenarios: {
    description: "Compare multiple workforce scenario requests or saved scenario IDs.",
    inputSchema: { type: "object", properties: { scenarioIds: arrayOrString("Scenario IDs."), scenarioRequests: { type: "array", items: { type: "object" } } } }
  },
  save_workforce_scenario: {
    description: "Save a workforce scenario in mock state.",
    inputSchema: { type: "object", properties: { scenario: { type: "object" } }, required: ["scenario"] }
  },
  create_known_event: {
    description: "Create a known demand event and optional recurrence.",
    inputSchema: knownEventSchema()
  },
  update_known_event: {
    description: "Update a known demand event.",
    inputSchema: { type: "object", properties: { eventId: { type: "string" }, changes: { type: "object" } }, required: ["eventId", "changes"] }
  },
  link_pattern_to_event: {
    description: "Link a detected demand pattern to a known event.",
    inputSchema: { type: "object", properties: { patternId: { type: "string" }, eventId: { type: "string" }, notes: { type: "string" } }, required: ["patternId", "eventId"] }
  },
  classify_demand_pattern: {
    description: "Classify a pattern as event, data issue, seasonality, monitor, or rejected.",
    inputSchema: { type: "object", properties: { patternId: { type: "string" }, classification: { type: "string" }, reason: { type: "string" } }, required: ["patternId", "classification"] }
  },
  apply_forecast_event_adjustment: {
    description: "Apply a known event impact to mock forecast workload.",
    inputSchema: { type: "object", properties: { eventId: { type: "string" }, impactPercent: { type: "number" }, reason: { type: "string" } }, required: ["eventId"] }
  },
  remove_forecast_event_adjustment: {
    description: "Remove a known event impact from mock forecast workload.",
    inputSchema: { type: "object", properties: { eventId: { type: "string" }, reason: { type: "string" } }, required: ["eventId"] }
  },
  create_workforce_review_package: {
    description: "Create a review package from a workforce scenario or recommendation.",
    inputSchema: { type: "object", properties: { scenarioId: { type: "string" }, recommendationId: { type: "string" }, owner: { type: "string" }, notes: { type: "string" } } }
  },
  update_workforce_review_package: {
    description: "Mark a review package reviewed, approved, rejected, edited, or expired.",
    inputSchema: { type: "object", properties: { reviewPackageId: { type: "string" }, status: { type: "string" }, changes: { type: "object" }, reason: { type: "string" } }, required: ["reviewPackageId"] }
  },
  apply_workforce_scenario: {
    description: "Apply approved mock state changes from a scenario or review package.",
    inputSchema: { type: "object", properties: { scenarioId: { type: "string" }, reviewPackageId: { type: "string" }, sendCommunication: { type: "boolean" }, reason: { type: "string" } } }
  },
  rollback_workforce_scenario: {
    description: "Rollback a previously applied mock workforce scenario where supported.",
    inputSchema: { type: "object", properties: { scenarioId: { type: "string" }, reviewPackageId: { type: "string" }, reason: { type: "string" } } }
  },
  generate_workforce_review_summary: {
    description: "Generate a human-readable summary for manager review or communication.",
    inputSchema: { type: "object", properties: { scenarioId: { type: "string" }, reviewPackageId: { type: "string" } } }
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
  },
  get_forecast_summary: (args) => {
    const cells = filterCells(args);
    const patterns = demandPatterns(args);
    const totals = summarizeCells(cells);
    const chartView = buildForecastChart(cells, "Forecast workload outlook");
    return {
      generatedAt: BASE_NOW,
      filters: normalizedFilterSummary(args),
      horizon: horizonForCells(cells),
      kpis: {
        forecastExpectedMinutes: totals.forecastExpectedMinutes,
        forecastMinMinutes: totals.forecastMinMinutes,
        forecastMaxMinutes: totals.forecastMaxMinutes,
        planWorkloadMinutes: totals.planWorkloadMinutes,
        planVarianceMinutes: totals.planVarianceMinutes,
        bookedWorkloadMinutes: totals.bookedWorkloadMinutes,
        availableCapacityMinutes: totals.availableCapacityMinutes,
        capacityGapMinutes: totals.capacityGapMinutes,
        capacitySurplusMinutes: totals.capacitySurplusMinutes,
        availableResourceCount: totals.availableResourceCount,
        shortageAreaCount: new Set(cells.filter((cell) => cell.forecastedWorkloadMinutes > cell.availableCapacityMinutes).map((cell) => cell.area)).size,
        surplusAreaCount: new Set(cells.filter((cell) => cell.availableCapacityMinutes > cell.forecastMaxWorkloadMinutes).map((cell) => cell.area)).size,
        knownEventCount: filterKnownEvents(args).length,
        openRecommendationCount: TOOL_HANDLERS.analyze_forecast_workforce_recommendations({ ...args, limit: 100 }).items.length,
        detectedPatternCount: patterns.length
      },
      chartView,
      topRecommendations: TOOL_HANDLERS.analyze_forecast_workforce_recommendations({ ...args, limit: 5 }).items,
      topPatterns: patterns.slice(0, 5)
    };
  },
  get_forecast_workload_series: (args) => {
    const cells = filterCells(args);
    const byDate = groupCells(cells, (cell) => args.granularity === "week" ? weekKey(cell.date) : cell.date);
    const items = [...byDate.entries()].map(([period, periodCells]) => {
      const totals = summarizeCells(periodCells);
      return {
        period,
        date: args.granularity === "week" ? undefined : period,
        actualWorkloadMinutes: historicalActualForCells(periodCells),
        bookedWorkloadMinutes: totals.bookedWorkloadMinutes,
        forecastMinMinutes: totals.forecastMinMinutes,
        forecastExpectedMinutes: totals.forecastExpectedMinutes,
        forecastMaxMinutes: totals.forecastMaxMinutes,
        planWorkloadMinutes: totals.planWorkloadMinutes,
        availableCapacityMinutes: totals.availableCapacityMinutes,
        capacityGapMinutes: totals.capacityGapMinutes,
        knownEventIds: eventIdsForCells(periodCells)
      };
    }).sort((a, b) => a.period.localeCompare(b.period));
    return { generatedAt: BASE_NOW, granularity: args.granularity || "day", items };
  },
  get_forecast_geography_outlook: (args) => {
    const geoLevel = args.geoLevel || "region";
    const groups = groupCells(filterCells(args), (cell) => geographyKey(cell.area, geoLevel));
    const items = [...groups.entries()].map(([geoKey, cells]) => {
      const totals = summarizeCells(cells);
      const riskScoreValue = forecastRiskScore(totals);
      const surplusScoreValue = forecastSurplusScore(totals);
      return {
        geographyLevel: geoLevel,
        geographyKey: geoKey,
        areas: [...new Set(cells.map((cell) => cell.area))],
        mapState: riskScoreValue >= 40 ? "SHORTAGE" : surplusScoreValue >= 45 ? "SURPLUS" : "HEALTHY",
        riskScore: riskScoreValue,
        surplusScore: surplusScoreValue,
        forecastExpectedMinutes: totals.forecastExpectedMinutes,
        forecastMinMinutes: totals.forecastMinMinutes,
        forecastMaxMinutes: totals.forecastMaxMinutes,
        historicalBaselineMinutes: historicalActualForCells(cells),
        bookedWorkloadMinutes: totals.bookedWorkloadMinutes,
        availableCapacityMinutes: totals.availableCapacityMinutes,
        availableResourceCount: totals.availableResourceCount,
        skillGapMinutes: totals.skillGapMinutes,
        capacityGapMinutes: totals.capacityGapMinutes,
        capacitySurplusMinutes: totals.capacitySurplusMinutes,
        utilization: ratio(totals.forecastExpectedMinutes, totals.availableCapacityMinutes),
        planVarianceMinutes: totals.planVarianceMinutes,
        knownEvents: filterKnownEvents({ ...args, areas: [...new Set(cells.map((cell) => cell.area))] }).map(eventSummary),
        recommendedAction: geographyRecommendedAction(totals)
      };
    }).filter((item) => args.includeSurplus || item.mapState !== "SURPLUS" || item.surplusScore >= 45)
      .sort((a, b) => Math.max(b.riskScore, b.surplusScore) - Math.max(a.riskScore, a.surplusScore));
    return {
      generatedAt: BASE_NOW,
      geographyLevel: geoLevel,
      items,
      resourceCrunchMap: buildResourceCrunchMap(items, args),
      forecastChart: buildForecastChart(filterCells(args), "Demand Forecaster"),
      scheduleLeadTimeMatrix: buildScheduleLeadTimeMatrix(items)
    };
  },
  get_capacity_outlook: (args) => ({
    generatedAt: BASE_NOW,
    items: filterCells(args).map((cell) => {
      const totals = summarizeCells([cell]);
      return {
        date: cell.date,
        area: cell.area,
        geography: AREA_GEOGRAPHY[cell.area],
        capacityCategory: cell.capacityCategory,
        skill: cell.skill,
        timeSlot: cell.timeSlot,
        availableResourceCount: cell.availableResourceCount,
        availableCapacityMinutes: cell.availableCapacityMinutes,
        plannedCapacityMinutes: cell.calendarCapacityMinutes,
        contractorCapacityMinutes: temporaryCapacity(cell, "CONTRACTOR"),
        overtimeCapacityMinutes: temporaryCapacity(cell, "OVERTIME"),
        borrowableCapacityMinutes: temporaryCapacity(cell, "BORROW"),
        releaseCandidateMinutes: Math.max(0, cell.availableCapacityMinutes - cell.forecastMaxWorkloadMinutes),
        capacityGapMinutes: totals.capacityGapMinutes,
        skillGapMinutes: totals.skillGapMinutes,
        utilization: ratio(cell.forecastedWorkloadMinutes, cell.availableCapacityMinutes)
      };
    })
  }),
  get_demand_pattern_detail: (args) => {
    const pattern = args.patternId ? patternById(args.patternId) : selectPattern(args);
    const filters = pattern.filters || args;
    return {
      generatedAt: BASE_NOW,
      pattern,
      series: TOOL_HANDLERS.get_forecast_workload_series({ ...filters, dateRange: pattern.contextDateRange || filters.dateRange }).items,
      eventCandidates: filterKnownEvents(filters).map(eventSummary),
      forecastAdjustmentPreview: previewEventAdjustment(pattern, filterKnownEvents(filters)[0]),
      downstreamCapacityImpact: TOOL_HANDLERS.get_forecast_summary(filters).kpis,
      suggestedActions: patternSuggestedActions(pattern)
    };
  },
  get_known_events: (args) => ({
    generatedAt: BASE_NOW,
    items: filterKnownEvents(args)
  }),
  get_workforce_scenario: (args) => {
    const scenario = state.workforceScenarios.find((item) => item.scenarioId === args.scenarioId);
    if (!scenario) throw new ToolError("scenario_not_found", `No workforce scenario found for ${args.scenarioId}.`);
    return { generatedAt: BASE_NOW, scenario };
  },
  get_workforce_review_packages: (args) => ({
    generatedAt: BASE_NOW,
    items: state.reviewPackages.filter((pkg) =>
      (!args.reviewPackageId || pkg.reviewPackageId === args.reviewPackageId) &&
      matchList(pkg.status, normalizeList(args.status)) &&
      matchAny(pkg.areas || [], normalizeList(args.areas || args.area)) &&
      matchAny(pkg.capacityCategories || [], normalizeList(args.capacityCategories || args.capacityCategory))
    )
  }),
  analyze_forecast_workforce_recommendations: (args) => {
    let items = forecastRecommendations(args);
    if (!args.includeHealthy) items = items.filter((item) => item.severity !== "HEALTHY");
    items.sort((a, b) => b.score - a.score || a.dateRange.start.localeCompare(b.dateRange.start));
    const selected = items.slice(0, Number(args.limit || 20));
    for (const item of selected) state.recommendationCache.set(item.recommendationId, item);
    return { generatedAt: BASE_NOW, items: selected };
  },
  detect_demand_patterns: (args) => ({
    generatedAt: BASE_NOW,
    sensitivity: args.sensitivity || "medium",
    items: demandPatterns(args).slice(0, Number(args.limit || 20))
  }),
  explain_demand_pattern: (args) => {
    const pattern = args.patternId ? patternById(args.patternId) : selectPattern(args);
    return {
      generatedAt: BASE_NOW,
      patternId: pattern.patternId,
      patternType: pattern.patternType,
      hypothesis: pattern.agentHypothesis,
      confidence: pattern.confidence,
      evidence: pattern.evidence,
      likelyDrivers: pattern.likelyDrivers,
      suggestedUserQuestion: patternQuestion(pattern),
      recommendedNextActions: patternSuggestedActions(pattern)
    };
  },
  recommend_workforce_actions: (args) => {
    const recommendation = args.recommendationId ? forecastRecommendationById(args.recommendationId) : forecastRecommendations(args)[0];
    if (!recommendation) throw new ToolError("recommendation_not_found", "No matching forecast workforce recommendation found.", args);
    return {
      generatedAt: BASE_NOW,
      recommendationId: recommendation.recommendationId,
      sourceType: recommendation.recommendationType,
      actions: workforceActionOptions(recommendation),
      preferredActionCode: workforceActionOptions(recommendation)[0]?.actionCode,
      communicationDraft: {
        subject: `${recommendation.area} ${recommendation.capacityCategory} workforce recommendation`,
        message: `${recommendation.recommendedAction}. Expected impact: ${recommendation.expectedImpact.summary}`
      }
    };
  },
  recommend_forecast_booking_controls: (args) => {
    const recommendation = args.recommendationId ? forecastRecommendationById(args.recommendationId) : null;
    const scenario = args.scenarioId ? state.workforceScenarios.find((item) => item.scenarioId === args.scenarioId) : null;
    const filters = recommendation ? recommendation.filters : scenario ? scenario.filters : args;
    const cell = selectCell(filters);
    const booking = TOOL_HANDLERS.recommend_booking_controls(cellToFilter(cell));
    return {
      ...booking,
      generatedAt: BASE_NOW,
      sourceRecommendationId: recommendation?.recommendationId,
      sourceScenarioId: scenario?.scenarioId,
      forecastContext: {
        forecastExpectedMinutes: cell.forecastedWorkloadMinutes,
        forecastMaxMinutes: cell.forecastMaxWorkloadMinutes,
        availableCapacityMinutes: cell.availableCapacityMinutes,
        residualGapAfterScenarioMinutes: scenario?.afterMetrics?.capacityGapMinutes ?? Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes)
      }
    };
  },
  simulate_workforce_scenario: (args) => {
    const recommendation = args.recommendationId ? forecastRecommendationById(args.recommendationId) : null;
    const filters = recommendation ? recommendation.filters : args;
    const scenarioActions = args.scenarioActions?.length ? args.scenarioActions : workforceActionOptions(recommendation || forecastRecommendations(filters)[0] || {}).slice(0, 1);
    const scenario = buildScenario({
      scenarioName: args.scenarioName || recommendation?.title || "Forecast workforce scenario",
      sourceRecommendationId: recommendation?.recommendationId,
      filters,
      scenarioActions
    });
    if (args.save) state.workforceScenarios.push(scenario);
    audit("simulate_workforce_scenario", args, { scenarioId: scenario.scenarioId, saved: Boolean(args.save), recommendedDecision: scenario.recommendedDecision });
    return { generatedAt: BASE_NOW, scenario };
  },
  compare_workforce_scenarios: (args) => {
    const saved = normalizeList(args.scenarioIds)?.map((scenarioId) => {
      const scenario = state.workforceScenarios.find((item) => item.scenarioId === scenarioId);
      if (!scenario) throw new ToolError("scenario_not_found", `No workforce scenario found for ${scenarioId}.`);
      return scenario;
    }) || [];
    const simulated = (args.scenarioRequests || []).map((request) => TOOL_HANDLERS.simulate_workforce_scenario({ ...request, save: false }).scenario);
    const items = [...saved, ...simulated].map((scenario) => ({
      scenarioId: scenario.scenarioId,
      scenarioName: scenario.scenarioName,
      actionSummary: scenario.scenarioActions.map(actionLabel).join("; "),
      capacityGapAfterMinutes: scenario.afterMetrics.capacityGapMinutes,
      surplusAfterMinutes: scenario.afterMetrics.capacitySurplusMinutes,
      utilizationAfter: scenario.afterMetrics.utilization,
      residualRisk: scenario.residualRisk,
      recommendedDecision: scenario.recommendedDecision,
      score: scenarioComparisonScore(scenario)
    })).sort((a, b) => b.score - a.score);
    return { generatedAt: BASE_NOW, items };
  },
  save_workforce_scenario: (args) => {
    const scenario = {
      ...args.scenario,
      scenarioId: args.scenario.scenarioId || `SCN-${String(state.workforceScenarios.length + 1).padStart(5, "0")}`,
      savedAt: BASE_NOW
    };
    state.workforceScenarios.push(scenario);
    audit("save_workforce_scenario", args, scenario);
    return { generatedAt: BASE_NOW, scenario };
  },
  create_known_event: (args) => {
    const event = normalizeKnownEvent(args, `EVT-${String(state.knownEvents.length + 1).padStart(5, "0")}`);
    state.knownEvents.push(event);
    audit("create_known_event", args, event);
    return { generatedAt: BASE_NOW, event };
  },
  update_known_event: (args) => {
    const event = findKnownEvent(args.eventId);
    Object.assign(event, normalizeKnownEvent({ ...event, ...args.changes }, event.eventId), { updatedAt: BASE_NOW });
    audit("update_known_event", args, event);
    return { generatedAt: BASE_NOW, event };
  },
  link_pattern_to_event: (args) => {
    const event = findKnownEvent(args.eventId);
    const pattern = patternById(args.patternId);
    const link = {
      linkId: `LINK-${String(state.patternLinks.length + 1).padStart(5, "0")}`,
      linkedAt: BASE_NOW,
      patternId: args.patternId,
      eventId: args.eventId,
      notes: args.notes || `Pattern linked to ${event.eventName}`
    };
    state.patternLinks.push(link);
    audit("link_pattern_to_event", args, link);
    return { generatedAt: BASE_NOW, link, pattern, event };
  },
  classify_demand_pattern: (args) => {
    const pattern = patternById(args.patternId);
    const classification = {
      classificationId: `PATCLS-${String(state.patternClassifications.length + 1).padStart(5, "0")}`,
      classifiedAt: BASE_NOW,
      patternId: args.patternId,
      classification: args.classification,
      reason: args.reason || ""
    };
    state.patternClassifications.push(classification);
    audit("classify_demand_pattern", args, classification);
    return { generatedAt: BASE_NOW, pattern, classification };
  },
  apply_forecast_event_adjustment: (args) => {
    const event = findKnownEvent(args.eventId);
    if (event.forecastAdjustmentState === "applied") {
      return { generatedAt: BASE_NOW, event, adjustedCount: 0, message: "Event adjustment already applied." };
    }
    const impactPercent = Number(args.impactPercent ?? event.impactPercent ?? 0);
    const cells = filterCells({
      dateRange: { start: event.startDate, end: event.endDate },
      areas: event.areas,
      capacityCategories: event.capacityCategories,
      activityTypes: event.activityTypes,
      skills: event.skills
    });
    const adjustment = {
      adjustmentId: `ADJ-${String(state.eventAdjustments.length + 1).padStart(5, "0")}`,
      eventId: event.eventId,
      appliedAt: BASE_NOW,
      impactPercent,
      cells: cells.map((cell) => ({ riskId: riskIdForCell(cell), before: cell.forecastedWorkloadMinutes }))
    };
    for (const cell of cells) {
      cell.forecastedWorkloadMinutes = Math.max(0, Math.round(cell.forecastedWorkloadMinutes * (1 + impactPercent / 100)));
      cell.forecastMinWorkloadMinutes = Math.max(0, Math.round(cell.forecastMinWorkloadMinutes * (1 + impactPercent / 100)));
      cell.forecastMaxWorkloadMinutes = Math.max(0, Math.round(cell.forecastMaxWorkloadMinutes * (1 + impactPercent / 100)));
      cell.planVarianceMinutes = cell.forecastedWorkloadMinutes - cell.planWorkloadMinutes;
      cell.eventImpactId = event.eventId;
    }
    event.forecastAdjustmentState = "applied";
    state.eventAdjustments.push(adjustment);
    audit("apply_forecast_event_adjustment", args, { eventId: event.eventId, adjustedCount: cells.length, impactPercent });
    return { generatedAt: BASE_NOW, event, adjustmentId: adjustment.adjustmentId, adjustedCount: cells.length, impactPercent, adjustedRows: cells.map(toHeatmapCell) };
  },
  remove_forecast_event_adjustment: (args) => {
    const event = findKnownEvent(args.eventId);
    const adjustment = [...state.eventAdjustments].reverse().find((item) => item.eventId === event.eventId && !item.removedAt);
    if (!adjustment) return { generatedAt: BASE_NOW, event, restoredCount: 0, message: "No active adjustment found." };
    let restoredCount = 0;
    for (const row of adjustment.cells) {
      const cell = state.cells.find((candidate) => riskIdForCell(candidate) === row.riskId);
      if (!cell) continue;
      cell.forecastedWorkloadMinutes = row.before;
      cell.forecastMinWorkloadMinutes = Math.max(0, row.before - 420);
      cell.forecastMaxWorkloadMinutes = row.before + 420;
      cell.planVarianceMinutes = cell.forecastedWorkloadMinutes - cell.planWorkloadMinutes;
      if (cell.eventImpactId === event.eventId) delete cell.eventImpactId;
      restoredCount += 1;
    }
    adjustment.removedAt = BASE_NOW;
    event.forecastAdjustmentState = "proposed";
    audit("remove_forecast_event_adjustment", args, { eventId: event.eventId, restoredCount });
    return { generatedAt: BASE_NOW, event, restoredCount };
  },
  create_workforce_review_package: (args) => {
    const scenario = args.scenarioId
      ? state.workforceScenarios.find((item) => item.scenarioId === args.scenarioId)
      : TOOL_HANDLERS.simulate_workforce_scenario({ recommendationId: args.recommendationId, save: true }).scenario;
    if (!scenario) throw new ToolError("scenario_not_found", "No scenario found or generated for review package.", args);
    const reviewPackage = {
      reviewPackageId: `WRP-${String(state.reviewPackages.length + 1).padStart(5, "0")}`,
      createdAt: BASE_NOW,
      scenarioId: scenario.scenarioId,
      sourceRecommendationId: scenario.sourceRecommendationId,
      owner: args.owner || "Operations Manager",
      status: "draft",
      notes: args.notes || "",
      areas: normalizeList(scenario.filters.areas || scenario.filters.area) || [],
      capacityCategories: normalizeList(scenario.filters.capacityCategories || scenario.filters.capacityCategory) || [],
      beforeMetrics: scenario.beforeMetrics,
      afterMetrics: scenario.afterMetrics,
      recommendedDecision: scenario.recommendedDecision,
      summary: reviewSummaryForScenario(scenario)
    };
    state.reviewPackages.push(reviewPackage);
    audit("create_workforce_review_package", args, reviewPackage);
    return { generatedAt: BASE_NOW, reviewPackage };
  },
  update_workforce_review_package: (args) => {
    const reviewPackage = findReviewPackage(args.reviewPackageId);
    Object.assign(reviewPackage, args.changes || {}, {
      status: args.status || args.changes?.status || reviewPackage.status,
      updatedAt: BASE_NOW,
      lastReason: args.reason || reviewPackage.lastReason
    });
    audit("update_workforce_review_package", args, reviewPackage);
    return { generatedAt: BASE_NOW, reviewPackage };
  },
  apply_workforce_scenario: (args) => {
    const scenario = scenarioFromArgs(args);
    const before = filterCells(scenario.filters).map((cell) => ({ riskId: riskIdForCell(cell), availableCapacityMinutes: cell.availableCapacityMinutes }));
    const capacityDelta = scenarioCapacityDelta(scenario);
    const cells = filterCells(scenario.filters);
    for (const cell of cells) {
      cell.availableCapacityMinutes = Math.max(0, cell.availableCapacityMinutes + capacityDelta);
      cell.availableResourceCount = Math.max(0, Math.round(cell.availableCapacityMinutes / 330));
    }
    scenario.status = "applied";
    scenario.appliedAt = BASE_NOW;
    scenario.rollbackSnapshot = before;
    const reviewPackage = args.reviewPackageId ? findReviewPackage(args.reviewPackageId) : null;
    if (reviewPackage) reviewPackage.status = "applied";
    const communication = args.sendCommunication
      ? TOOL_HANDLERS.send_communication({
        audience: ["Operations Manager", "Capacity Planning"],
        communicationType: "WORKFORCE_SCENARIO_APPLIED",
        subject: `${scenario.scenarioName} applied`,
        message: reviewSummaryForScenario(scenario),
        actionIds: [scenario.scenarioId, reviewPackage?.reviewPackageId].filter(Boolean)
      })
      : null;
    audit("apply_workforce_scenario", args, { scenarioId: scenario.scenarioId, updatedCellCount: cells.length, capacityDelta });
    return { generatedAt: BASE_NOW, scenario, updatedCellCount: cells.length, capacityDeltaMinutesPerCell: capacityDelta, communication };
  },
  rollback_workforce_scenario: (args) => {
    const scenario = scenarioFromArgs(args);
    if (!scenario.rollbackSnapshot) {
      return { generatedAt: BASE_NOW, scenario, restoredCount: 0, message: "Scenario has no rollback snapshot." };
    }
    let restoredCount = 0;
    for (const snapshot of scenario.rollbackSnapshot) {
      const cell = state.cells.find((candidate) => riskIdForCell(candidate) === snapshot.riskId);
      if (!cell) continue;
      cell.availableCapacityMinutes = snapshot.availableCapacityMinutes;
      cell.availableResourceCount = Math.max(0, Math.round(cell.availableCapacityMinutes / 330));
      restoredCount += 1;
    }
    scenario.status = "rolled_back";
    scenario.rolledBackAt = BASE_NOW;
    audit("rollback_workforce_scenario", args, { scenarioId: scenario.scenarioId, restoredCount });
    return { generatedAt: BASE_NOW, scenario, restoredCount };
  },
  generate_workforce_review_summary: (args) => {
    const scenario = scenarioFromArgs(args);
    const reviewPackage = args.reviewPackageId ? findReviewPackage(args.reviewPackageId) : null;
    return {
      generatedAt: BASE_NOW,
      scenarioId: scenario.scenarioId,
      reviewPackageId: reviewPackage?.reviewPackageId,
      summary: reviewSummaryForScenario(scenario),
      beforeMetrics: scenario.beforeMetrics,
      afterMetrics: scenario.afterMetrics,
      recommendedDecision: scenario.recommendedDecision
    };
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
  return {
    cells,
    activities,
    knownEvents: createKnownEvents(),
    workforceScenarios: [],
    reviewPackages: [],
    patternLinks: [],
    patternClassifications: [],
    eventAdjustments: [],
    recommendationCache: new Map(),
    communications: [],
    recommendationStates: [],
    auditEvents: []
  };
}

function createKnownEvents() {
  return [
    normalizeKnownEvent({
      eventName: "Summer fiber upgrade campaign",
      eventType: "campaign",
      startDate: "2026-05-14",
      endDate: "2026-05-21",
      areas: ["NORTH"],
      capacityCategories: ["FIBER_INSTALL"],
      activityTypes: ["INSTALL"],
      skills: ["FIBER_L2"],
      impactDirection: "increase_workload",
      impactPercent: 18,
      recurrence: "yearly",
      notes: "Seed event explaining sustained Fiber Install demand.",
      forecastAdjustmentState: "proposed"
    }, "EVT-00001"),
    normalizeKnownEvent({
      eventName: "Regional appliance service sale",
      eventType: "sale",
      startDate: "2026-05-16",
      endDate: "2026-05-23",
      areas: ["SOUTH", "EAST"],
      capacityCategories: ["REPAIR"],
      activityTypes: ["REPAIR"],
      skills: ["COPPER"],
      impactDirection: "increase_workload",
      impactPercent: 35,
      recurrence: "monthly",
      notes: "Seed event used by Demand Pattern Investigator.",
      forecastAdjustmentState: "proposed"
    }, "EVT-00002")
  ];
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

function summarizeCells(cells) {
  const forecastExpectedMinutes = sum(cells, "forecastedWorkloadMinutes");
  const forecastMinMinutes = sum(cells, "forecastMinWorkloadMinutes");
  const forecastMaxMinutes = sum(cells, "forecastMaxWorkloadMinutes");
  const planWorkloadMinutes = sum(cells, "planWorkloadMinutes");
  const bookedWorkloadMinutes = sum(cells, "bookedWorkloadMinutes");
  const availableCapacityMinutes = sum(cells, "availableCapacityMinutes");
  const availableResourceCount = sum(cells, "availableResourceCount");
  return {
    forecastExpectedMinutes,
    forecastMinMinutes,
    forecastMaxMinutes,
    planWorkloadMinutes,
    planVarianceMinutes: forecastExpectedMinutes - planWorkloadMinutes,
    bookedWorkloadMinutes,
    availableCapacityMinutes,
    availableResourceCount,
    capacityGapMinutes: Math.max(0, forecastExpectedMinutes - availableCapacityMinutes),
    capacitySurplusMinutes: Math.max(0, availableCapacityMinutes - forecastMaxMinutes),
    skillGapMinutes: sum(cells.map((cell) => ({ gap: Math.max(0, cell.forecastedWorkloadMinutes - cell.availableCapacityMinutes) })), "gap"),
    utilization: ratio(forecastExpectedMinutes, availableCapacityMinutes)
  };
}

function horizonForCells(cells) {
  const dates = cells.map((cell) => cell.date).sort();
  return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
}

function normalizedFilterSummary(args = {}) {
  return {
    dates: normalizeList(expandDateRange(args).dates || args.date),
    areas: normalizeList(args.areas || args.area),
    capacityCategories: normalizeList(args.capacityCategories || args.capacityCategory),
    skills: normalizeList(args.skills || args.skill),
    timeSlots: normalizeList(args.timeSlots || args.timeSlot)
  };
}

function groupCells(cells, keyFn) {
  const groups = new Map();
  for (const cell of cells) {
    const key = keyFn(cell);
    groups.set(key, [...(groups.get(key) || []), cell]);
  }
  return groups;
}

function weekKey(date) {
  const cursor = new Date(`${date}T00:00:00Z`);
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() - day + 1);
  return cursor.toISOString().slice(0, 10);
}

function historicalActualForCells(cells) {
  return cells.reduce((total, cell) => total + historicalActualForCell(cell), 0);
}

function historicalActualForCell(cell) {
  const seasonal = cell.area === "SOUTH" && cell.capacityCategory === "REPAIR" ? 1.08 : 0.94;
  const patternLift = cell.date === "2026-05-16" && cell.area === "SOUTH" && cell.capacityCategory === "REPAIR" ? 1.28 : 1;
  return Math.round(cell.planWorkloadMinutes * seasonal * patternLift);
}

function eventIdsForCells(cells) {
  const areas = [...new Set(cells.map((cell) => cell.area))];
  const categories = [...new Set(cells.map((cell) => cell.capacityCategory))];
  const dates = cells.map((cell) => cell.date).sort();
  return filterKnownEvents({
    dateRange: { start: dates[0], end: dates[dates.length - 1] },
    areas,
    capacityCategories: categories
  }).map((event) => event.eventId);
}

function geographyKey(area, geoLevel) {
  if (geoLevel === "area") return area;
  return AREA_GEOGRAPHY[area]?.[geoLevel] || area;
}

function forecastRiskScore(totals) {
  const gapRatio = totals.capacityGapMinutes / Math.max(1, totals.forecastExpectedMinutes);
  const planVarianceRatio = Math.max(0, totals.planVarianceMinutes) / Math.max(1, totals.planWorkloadMinutes);
  return Math.min(100, Math.round((gapRatio * 65 + planVarianceRatio * 25 + ratio(totals.bookedWorkloadMinutes, totals.availableCapacityMinutes) * 10) * 2.2));
}

function forecastSurplusScore(totals) {
  const surplusRatio = totals.capacitySurplusMinutes / Math.max(1, totals.availableCapacityMinutes);
  const lowBookedRatio = Math.max(0, 1 - ratio(totals.bookedWorkloadMinutes, totals.availableCapacityMinutes));
  return Math.min(100, Math.round((surplusRatio * 70 + lowBookedRatio * 20) * 1.7));
}

function geographyRecommendedAction(totals) {
  if (totals.capacityGapMinutes > 0) return "Simulate add capacity, overtime, contractor coverage, or quota controls";
  if (totals.capacitySurplusMinutes > 0) return "Simulate redeploy or release temporary capacity";
  return "Monitor forecast and known events";
}

function temporaryCapacity(cell, type) {
  if (type === "CONTRACTOR") return cell.capacityCategory === "FIBER_INSTALL" || cell.capacityCategory === "REPAIR" ? 660 : 330;
  if (type === "OVERTIME") return Math.max(240, cell.availableResourceCount * 45);
  if (type === "BORROW") return cell.area === "EAST" || cell.area === "WEST" ? 480 : 300;
  return 0;
}

function forecastRecommendations(args = {}) {
  const cells = filterCells(args);
  const recommendations = [];
  const groups = groupCells(cells, (cell) => [cell.area, cell.capacityCategory, cell.skill].join("|"));
  for (const [key, group] of groups.entries()) {
    const [area, capacityCategory, skill] = key.split("|");
    const totals = summarizeCells(group);
    const dates = group.map((cell) => cell.date).sort();
    const filters = {
      dateRange: { start: dates[0], end: dates[dates.length - 1] },
      areas: [area],
      capacityCategories: [capacityCategory],
      skills: [skill]
    };
    if (totals.capacityGapMinutes > 900) {
      const score = forecastRiskScore(totals);
      recommendations.push({
        recommendationId: `FWA-SHORT-${hashId(key + dates[0])}`,
        recommendationType: "ADD_CAPACITY",
        title: `${area} ${capacityCategory} needs additional ${skill} capacity`,
        severity: riskLevelForScore(score),
        score,
        confidence: Number(Math.min(0.94, 0.7 + score / 400).toFixed(2)),
        dateRange: filters.dateRange,
        area,
        capacityCategory,
        requiredSkill: skill,
        filters,
        forecastExpectedMinutes: totals.forecastExpectedMinutes,
        forecastMinMinutes: totals.forecastMinMinutes,
        forecastMaxMinutes: totals.forecastMaxMinutes,
        planVarianceMinutes: totals.planVarianceMinutes,
        historicalBaselineMinutes: historicalActualForCells(group),
        bookedWorkloadMinutes: totals.bookedWorkloadMinutes,
        availableResourceCount: totals.availableResourceCount,
        availableCapacityMinutes: totals.availableCapacityMinutes,
        capacityGapOrSurplusMinutes: totals.capacityGapMinutes,
        rootCause: totals.planVarianceMinutes > 0 ? "Forecast is above plan and exceeds available skilled capacity" : "Available skilled capacity is below expected workload",
        recommendedAction: "Simulate contractor coverage, overtime, borrowing resources, or quota controls",
        expectedImpact: {
          summary: `Close up to ${totals.capacityGapMinutes} capacity minutes over ${dates.length} days`,
          capacityGapBeforeMinutes: totals.capacityGapMinutes,
          capacityGapAfterMinutes: Math.max(0, totals.capacityGapMinutes - 1320)
        },
        nextBestAction: "Simulate recommendation"
      });
    } else if (totals.capacitySurplusMinutes > 1200) {
      const score = forecastSurplusScore(totals);
      recommendations.push({
        recommendationId: `FWA-SURPLUS-${hashId(key + dates[0])}`,
        recommendationType: "REDEPLOY_OR_RELEASE",
        title: `${area} ${capacityCategory} has sustained surplus ${skill} capacity`,
        severity: score >= 60 ? "OPPORTUNITY" : "WATCH",
        score,
        confidence: 0.76,
        dateRange: filters.dateRange,
        area,
        capacityCategory,
        requiredSkill: skill,
        filters,
        forecastExpectedMinutes: totals.forecastExpectedMinutes,
        forecastMinMinutes: totals.forecastMinMinutes,
        forecastMaxMinutes: totals.forecastMaxMinutes,
        planVarianceMinutes: totals.planVarianceMinutes,
        historicalBaselineMinutes: historicalActualForCells(group),
        bookedWorkloadMinutes: totals.bookedWorkloadMinutes,
        availableResourceCount: totals.availableResourceCount,
        availableCapacityMinutes: totals.availableCapacityMinutes,
        capacityGapOrSurplusMinutes: totals.capacitySurplusMinutes,
        rootCause: "Forecast max remains below available capacity across the selected horizon",
        recommendedAction: "Simulate redeploying resources, releasing temporary capacity, or reopening booking",
        expectedImpact: {
          summary: `Redeploy or release up to ${Math.round(totals.capacitySurplusMinutes / 330)} resource-days`,
          surplusBeforeMinutes: totals.capacitySurplusMinutes,
          surplusAfterMinutes: Math.max(0, totals.capacitySurplusMinutes - 990)
        },
        nextBestAction: "Compare redeploy and release options"
      });
    }
  }
  for (const pattern of demandPatterns(args).slice(0, 4)) {
    recommendations.push({
      recommendationId: `FWA-PATTERN-${hashId(pattern.patternId)}`,
      recommendationType: "INVESTIGATE_PATTERN",
      title: pattern.title,
      severity: pattern.score >= 75 ? "AT_RISK" : "WATCH",
      score: pattern.score,
      confidence: pattern.confidence,
      dateRange: pattern.dateRange,
      area: pattern.area,
      capacityCategory: pattern.capacityCategory,
      requiredSkill: pattern.skill,
      filters: pattern.filters,
      rootCause: pattern.agentHypothesis,
      recommendedAction: "Ask user to confirm event, recurrence, or data issue",
      expectedImpact: { summary: "Improves downstream workforce recommendation quality" },
      nextBestAction: "Investigate pattern"
    });
  }
  return recommendations;
}

function buildForecastChart(cells, title) {
  const series = [...groupCells(cells, (cell) => cell.date).entries()]
    .map(([date, dayCells]) => {
      const totals = summarizeCells(dayCells);
      return {
        date,
        label: date.slice(5),
        actualWorkloadMinutes: historicalActualForCells(dayCells),
        availableCapacityMinutes: totals.availableCapacityMinutes,
        forecastMinMinutes: totals.forecastMinMinutes,
        forecastExpectedMinutes: totals.forecastExpectedMinutes,
        forecastMaxMinutes: totals.forecastMaxMinutes,
        bookedWorkloadMinutes: totals.bookedWorkloadMinutes
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    title,
    xAxisLabel: "Date",
    yAxisLabel: "Minutes",
    series,
    chartWidgetConfig: {
      type: "line",
      data: {
        labels: series.map((item) => item.label),
        datasets: [
          { label: "Available Resources", data: series.map((item) => item.availableCapacityMinutes) },
          { label: "Actual Workload", data: series.map((item) => item.actualWorkloadMinutes) },
          { label: "Forecasted Max Workload", data: series.map((item) => item.forecastMaxMinutes) },
          { label: "Forecasted Min Workload", data: series.map((item) => item.forecastMinMinutes) },
          { label: "Booked Workload", data: series.map((item) => item.bookedWorkloadMinutes) }
        ]
      },
      insights: [
        "Compare available resources with actual workload and forecast min/max workload.",
        "Resource crunch exists when forecasted workload stays above available resources."
      ]
    }
  };
}

function buildResourceCrunchMap(items, args) {
  const zones = items.map((item, index) => {
    const area = item.areas[0] || AREAS[index % AREAS.length];
    const geometry = mapGeometryForArea(area, index);
    const crunchScore = Math.max(item.riskScore || 0, item.surplusScore || 0);
    const stateColor = item.mapState === "SHORTAGE" ? "#c2410c" : item.mapState === "SURPLUS" ? "#047857" : "#64748b";
    return {
      zoneId: item.geographyKey,
      area,
      label: item.geographyKey,
      mapState: item.mapState,
      stateColor,
      crunchScore,
      utilization: item.utilization,
      capacityGapMinutes: item.capacityGapMinutes,
      capacitySurplusMinutes: item.capacitySurplusMinutes,
      requiredResourceCount: Math.max(0, Math.ceil(item.capacityGapMinutes / 1980)),
      productivityGainHoursPerWeek: Math.max(0, Math.round(item.capacityGapMinutes / 60 / 2)),
      requiredWorkSkills: dominantSkillsForAreas(item.areas),
      optionalWorkSkills: ["Maintenance", "Deinstall"],
      locationLabel: locationLabelForArea(area),
      center: geometry.center,
      polygon: geometry.polygon
    };
  });
  const demandDots = zones.flatMap((zone, zoneIndex) => makeDemandDots(zone, zoneIndex));
  const resourceMarkers = zones.map((zone, index) => ({
    markerId: `RES-MARKER-${index + 1}`,
    zoneId: zone.zoneId,
    x: zone.center.x,
    y: zone.center.y,
    resourceCount: Math.max(1, Math.round((100 - zone.crunchScore) / 15)),
    highlighted: zone.mapState === "SHORTAGE",
    label: zone.requiredResourceCount > 0 ? `Hire ${zone.requiredResourceCount}` : "Monitor"
  }));
  const selectedInsightZone = [...zones].sort((a, b) => b.capacityGapMinutes - a.capacityGapMinutes)[0] || zones[0];
  return {
    title: "Resource crunch heat map",
    subtitle: "Demand density and resource markers by Field Service region",
    dateRange: args.dateRange || horizonForCells(filterCells(args)),
    zones,
    demandDots,
    resourceMarkers,
    insight: selectedInsightZone ? {
      title: `Hire ${selectedInsightZone.requiredResourceCount || 1} resource to increase productivity`,
      description: `Expected productivity gain is ${selectedInsightZone.productivityGainHoursPerWeek || 12} extra hrs per week in ${selectedInsightZone.locationLabel}.`,
      requiredWorkSkills: selectedInsightZone.requiredWorkSkills,
      optionalWorkSkills: selectedInsightZone.optionalWorkSkills,
      location: selectedInsightZone.locationLabel
    } : null,
    svgDataUrl: buildResourceCrunchSvgDataUrl(zones, demandDots, resourceMarkers, selectedInsightZone)
  };
}

function buildScheduleLeadTimeMatrix(items) {
  const months = ["Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"];
  const highestRisk = items.reduce((max, item) => Math.max(max, item.riskScore || 0), 0);
  const current = [3.5, 4.1, 4.4, 4.9, null, null, null, null, null];
  const forecasted = [null, null, null, null, 5.3, 5.5, 5.8, 6.1, 6.4].map((value) => value === null ? null : Number((value + highestRisk / 200).toFixed(1)));
  const implemented = forecasted.map((value) => value === null ? null : Number(Math.max(3.8, value - 0.4).toFixed(1)));
  return {
    title: "Average days to schedule",
    months,
    rows: [
      { label: "Avg. no. of days to schedule", values: current },
      { label: "Forecasted avg no. of days to schedule", values: forecasted },
      { label: "Forecasted avg no. of days to schedule if implemented", values: implemented }
    ]
  };
}

function mapGeometryForArea(area, index) {
  const geometries = {
    NORTH: { center: { x: 62, y: 26 }, polygon: "50,10 82,12 92,32 70,43 48,34" },
    SOUTH: { center: { x: 55, y: 70 }, polygon: "38,54 70,52 82,78 58,88 36,80" },
    EAST: { center: { x: 82, y: 48 }, polygon: "70,31 94,35 96,66 76,68 68,50" },
    WEST: { center: { x: 25, y: 46 }, polygon: "8,28 42,30 38,65 14,68 4,48" }
  };
  return geometries[area] || { center: { x: 20 + index * 18, y: 40 + index * 7 }, polygon: "10,10 35,10 35,35 10,35" };
}

function dominantSkillsForAreas(areas = []) {
  if (areas.includes("NORTH")) return ["Install", "Fiber L2"];
  if (areas.includes("SOUTH")) return ["Repair", "Copper"];
  if (areas.includes("EAST")) return ["Inspection", "Safety Certified"];
  return ["Maintenance", "Fiber L1"];
}

function locationLabelForArea(area) {
  const labels = {
    NORTH: "Boston, 02110",
    SOUTH: "Florida, 32013",
    EAST: "Newark, 07102",
    WEST: "San Jose, 95113"
  };
  return labels[area] || area;
}

function makeDemandDots(zone, zoneIndex) {
  const count = Math.max(12, Math.min(80, Math.round((zone.crunchScore || 35) * 0.85)));
  return Array.from({ length: count }, (_, index) => {
    const angle = (index * 137.5 + zoneIndex * 29) % 360;
    const radius = 3 + (index % 9) * 1.4;
    return {
      dotId: `DOT-${zoneIndex + 1}-${index + 1}`,
      zoneId: zone.zoneId,
      x: Math.max(4, Math.min(96, Number((zone.center.x + Math.cos(angle * Math.PI / 180) * radius).toFixed(1)))),
      y: Math.max(4, Math.min(92, Number((zone.center.y + Math.sin(angle * Math.PI / 180) * radius).toFixed(1)))),
      intensity: zone.mapState === "SHORTAGE" ? "high" : zone.mapState === "SURPLUS" ? "low" : "medium"
    };
  });
}

function buildResourceCrunchSvgDataUrl(zones, demandDots, resourceMarkers, selectedZone) {
  const zoneShapes = zones.map((zone) =>
    `<polygon points="${zone.polygon}" fill="${zone.mapState === "SHORTAGE" ? "#fff7ed" : zone.mapState === "SURPLUS" ? "#ecfdf5" : "#f8fafc"}" stroke="#e9d5ff" stroke-width="0.6"/>`
  ).join("");
  const dots = demandDots.map((dot) => `<circle cx="${dot.x}%" cy="${dot.y}%" r="0.55" fill="#b45309" opacity="0.86"/>`).join("");
  const markers = resourceMarkers.map((marker) => {
    const glow = marker.highlighted ? `<circle cx="${marker.x}%" cy="${marker.y}%" r="5.2" fill="#22c55e" opacity="0.35"/>` : "";
    return `${glow}<rect x="${marker.x - 1.6}%" y="${marker.y - 3.6}%" width="3.2%" height="4.2%" rx="0.4" fill="#ffffff" stroke="#94a3b8"/><circle cx="${marker.x}%" cy="${marker.y - 2.25}%" r="0.55" fill="#0284c7"/><path d="M ${marker.x - 0.8} ${marker.y - 0.8} Q ${marker.x} ${marker.y - 1.7} ${marker.x + 0.8} ${marker.y - 0.8}" stroke="#0284c7" stroke-width="0.3" fill="none"/><path d="M ${marker.x - 0.9} ${marker.y + 0.5} L ${marker.x} ${marker.y + 2.6} L ${marker.x + 0.9} ${marker.y + 0.5}" fill="#ffffff" stroke="#475569" stroke-width="0.35"/>`;
  }).join("");
  const insight = selectedZone ? `<text x="71%" y="17%" font-size="4" fill="#0f172a">Insights</text><text x="72%" y="23%" font-size="3.4" fill="#0369a1">Hire ${selectedZone.requiredResourceCount || 1} resource to increase</text><text x="72%" y="28%" font-size="3.4" fill="#0369a1">productivity by ${selectedZone.productivityGainHoursPerWeek || 12} extra hrs/week</text><text x="72%" y="39%" font-size="2.8" fill="#334155">Required Work Skills: ${selectedZone.requiredWorkSkills.join(", ")}</text><text x="72%" y="44%" font-size="2.8" fill="#334155">Optional Work Skills: ${selectedZone.optionalWorkSkills.join(", ")}</text><text x="72%" y="49%" font-size="2.8" fill="#334155">Location: ${selectedZone.locationLabel}</text>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620"><rect width="1200" height="620" fill="#ffffff"/><text x="32" y="42" font-size="24" font-family="Arial" fill="#0f172a">Resource Crunch Heat Map</text><g transform="translate(40,70) scale(8.1 5.1)">${zoneShapes}${dots}${markers}</g>${insight}<text x="32" y="590" font-size="17" font-family="Arial" fill="#64748b">Brown dots = forecast demand density. Pins = available resources. Green glow = best add-resource opportunity.</text></svg>`;
  return `data:image/svg+xml;base64,${base64Encode(svg)}`;
}

function base64Encode(value) {
  if (typeof btoa === "function") return btoa(value);
  if (typeof Buffer !== "undefined") return Buffer.from(value, "utf8").toString("base64");
  throw new Error("No base64 encoder available in this runtime.");
}

function forecastRecommendationById(recommendationId) {
  const recommendation = state.recommendationCache.get(recommendationId) || forecastRecommendations({ includeHealthy: true }).find((item) => item.recommendationId === recommendationId);
  if (!recommendation) throw new ToolError("recommendation_not_found", `No forecast workforce recommendation found for ${recommendationId}.`);
  return recommendation;
}

function demandPatterns(args = {}) {
  const cells = filterCells(args);
  const patterns = cells
    .map((cell) => {
      const actual = historicalActualForCell(cell);
      const deviation = cell.forecastedWorkloadMinutes - actual;
      const deviationRatio = deviation / Math.max(1, actual);
      const planRatio = Math.max(0, cell.planVarianceMinutes) / Math.max(1, cell.planWorkloadMinutes);
      const uncertaintyRatio = (cell.forecastMaxWorkloadMinutes - cell.forecastMinWorkloadMinutes) / Math.max(1, cell.forecastedWorkloadMinutes);
      const score = Math.min(100, Math.round((Math.abs(deviationRatio) * 45 + planRatio * 30 + uncertaintyRatio * 15) * 2.2));
      if (score < 35) return null;
      const patternType = deviationRatio > 0.2 ? "SPIKE" : deviationRatio < -0.18 ? "DROP" : planRatio > 0.2 ? "PLAN_MISS" : "WIDE_FORECAST_RANGE";
      const patternId = `PAT-${cell.date}-${cell.area}-${cell.capacityCategory}-${cell.timeSlot.replace(/[:]/g, "").replace("-", "")}`;
      const linked = state.patternLinks.find((link) => link.patternId === patternId);
      const classified = state.patternClassifications.find((item) => item.patternId === patternId);
      return {
        patternId,
        title: `${cell.area} ${cell.capacityCategory} ${patternType.toLowerCase().replace("_", " ")}`,
        patternType,
        score,
        dateRange: { start: cell.date, end: cell.date },
        contextDateRange: { start: addDays(cell.date, -3), end: addDays(cell.date, 6) },
        area: cell.area,
        capacityCategory: cell.capacityCategory,
        activityType: cell.activityType,
        skill: cell.skill,
        filters: cellToFilter(cell),
        actualWorkloadMinutes: actual,
        forecastExpectedMinutes: cell.forecastedWorkloadMinutes,
        historicalBaselineMinutes: Math.round(cell.planWorkloadMinutes * 0.96),
        forecastErrorMinutes: deviation,
        planVarianceMinutes: cell.planVarianceMinutes,
        bookedWorkloadMinutes: cell.bookedWorkloadMinutes,
        existingEventMatch: linked?.eventId || filterKnownEvents(cellToFilter(cell))[0]?.eventId,
        userConfirmationState: classified?.classification || (linked ? "confirmed_event" : "unreviewed"),
        futureRecurrenceImpact: filterKnownEvents(cellToFilter(cell))[0]?.recurrence || "unknown",
        agentHypothesis: patternHypothesis(patternType, cell),
        likelyDrivers: likelyDriversForPattern(patternType, cell),
        evidence: {
          deviationPercent: Math.round(deviationRatio * 100),
          forecastRangeMinutes: cell.forecastMaxWorkloadMinutes - cell.forecastMinWorkloadMinutes,
          planVarianceMinutes: cell.planVarianceMinutes
        },
        confidence: Number(Math.min(0.9, 0.55 + score / 300).toFixed(2))
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return patterns;
}

function patternById(patternId) {
  const pattern = demandPatterns({ includeHealthy: true }).find((item) => item.patternId === patternId);
  if (!pattern) throw new ToolError("pattern_not_found", `No demand pattern found for ${patternId}.`);
  return pattern;
}

function selectPattern(args = {}) {
  const pattern = demandPatterns(args)[0];
  if (!pattern) throw new ToolError("pattern_not_found", "No matching demand pattern found.", args);
  return pattern;
}

function patternHypothesis(patternType, cell) {
  if (patternType === "SPIKE") return `Workload is materially above historical baseline for ${cell.area} ${cell.capacityCategory}; check for sale, campaign, outage, or weather impact.`;
  if (patternType === "DROP") return `Workload is below historical baseline; check whether demand shifted, bookings closed early, or data is incomplete.`;
  if (patternType === "PLAN_MISS") return "Forecast is above plan; review plan assumptions and known events.";
  return "Forecast range widened; confirm whether uncertainty comes from event timing or volatile booking behavior.";
}

function likelyDriversForPattern(patternType, cell) {
  const event = filterKnownEvents(cellToFilter(cell))[0];
  return [
    event ? `Possible known event: ${event.eventName}` : "No matching known event recorded",
    patternType === "SPIKE" ? "Demand event or campaign" : "Booking policy or demand shift",
    cell.planVarianceMinutes > 0 ? "Plan variance" : "Historical deviation"
  ];
}

function patternQuestion(pattern) {
  return `Workload for ${pattern.area} ${pattern.capacityCategory} is ${Math.abs(pattern.evidence.deviationPercent)}% ${pattern.evidence.deviationPercent >= 0 ? "above" : "below"} baseline. Was this caused by a known sale, outage, campaign, weather event, or data correction?`;
}

function patternSuggestedActions(pattern) {
  return [
    { action: "Add new event", tool: "create_known_event" },
    { action: "Link existing event", tool: "link_pattern_to_event" },
    { action: "Classify as data issue", tool: "classify_demand_pattern" },
    { action: "Simulate workforce impact", tool: "simulate_workforce_scenario" }
  ];
}

function previewEventAdjustment(pattern, event) {
  if (!event) return null;
  const impactPercent = Number(event.impactPercent || 0);
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    impactPercent,
    forecastExpectedBeforeMinutes: pattern.forecastExpectedMinutes,
    forecastExpectedAfterMinutes: Math.round(pattern.forecastExpectedMinutes * (1 + impactPercent / 100))
  };
}

function workforceActionOptions(recommendation = {}) {
  const gap = Math.max(0, recommendation.capacityGapOrSurplusMinutes || recommendation.expectedImpact?.capacityGapBeforeMinutes || 1320);
  if (recommendation.recommendationType === "REDEPLOY_OR_RELEASE") {
    return [
      { actionCode: "REDEPLOY_RESOURCES", actionType: "redeploy_resources", resourceCount: 2, capacityMinutes: 1320, sourceArea: recommendation.area, targetArea: "SOUTH", durationDays: 5, riskLevel: "LOW" },
      { actionCode: "RELEASE_TEMP_CAPACITY", actionType: "release_temporary_capacity", resourceCount: 2, capacityMinutes: -1320, durationDays: 10, riskLevel: "MEDIUM" },
      { actionCode: "REOPEN_BOOKING", actionType: "booking_control", bookingStatus: "open", quotaDeltaMinutes: 900, riskLevel: "LOW" }
    ];
  }
  return [
    { actionCode: "ADD_CONTRACTOR_CAPACITY", actionType: "add_contractor_resources", resourceCount: Math.max(1, Math.ceil(gap / 2400)), capacityMinutes: Math.max(660, Math.min(gap, 2640)), durationDays: 10, riskLevel: "LOW" },
    { actionCode: "ADD_OVERTIME", actionType: "add_overtime", overtimeHours: 120, capacityMinutes: 7200, durationDays: 5, riskLevel: "MEDIUM" },
    { actionCode: "BORROW_RESOURCES", actionType: "borrow_resources", resourceCount: 2, sourceArea: "WEST", capacityMinutes: 1320, durationDays: 5, riskLevel: "MEDIUM" },
    { actionCode: "REDUCE_BOOKING_EXPOSURE", actionType: "booking_control", quotaDeltaMinutes: -900, bookingStatus: "restricted", riskLevel: "LOW" }
  ];
}

function buildScenario({ scenarioName, sourceRecommendationId, filters, scenarioActions }) {
  const cells = filterCells(filters);
  const beforeMetrics = summarizeCells(cells);
  const capacityDelta = scenarioActions.reduce((total, action) => total + Number(action.capacityMinutes || action.quotaDeltaMinutes || 0), 0);
  const forecastDelta = scenarioActions.reduce((total, action) => total + Number(action.forecastDeltaMinutes || 0), 0);
  const afterForecast = Math.max(0, beforeMetrics.forecastExpectedMinutes + forecastDelta);
  const afterCapacity = Math.max(0, beforeMetrics.availableCapacityMinutes + capacityDelta);
  const afterMetrics = {
    ...beforeMetrics,
    forecastExpectedMinutes: afterForecast,
    availableCapacityMinutes: afterCapacity,
    capacityGapMinutes: Math.max(0, afterForecast - afterCapacity),
    capacitySurplusMinutes: Math.max(0, afterCapacity - beforeMetrics.forecastMaxMinutes),
    utilization: ratio(afterForecast, afterCapacity)
  };
  return {
    scenarioId: `SCN-${String(state.workforceScenarios.length + 1).padStart(5, "0")}-${hashId(`${scenarioName}${state.workforceScenarios.length}`)}`,
    scenarioName,
    sourceRecommendationId,
    createdAt: BASE_NOW,
    status: "simulated",
    filters,
    timeHorizon: horizonForCells(cells),
    areas: [...new Set(cells.map((cell) => cell.area))],
    capacityCategories: [...new Set(cells.map((cell) => cell.capacityCategory))],
    scenarioActions,
    beforeMetrics,
    afterMetrics,
    residualRisk: riskLevelForScore(forecastRiskScore(afterMetrics)),
    recommendedDecision: afterMetrics.capacityGapMinutes <= beforeMetrics.capacityGapMinutes * 0.25 ? "REQUEST_APPROVAL" : "COMPARE_ALTERNATIVES",
    tradeoffs: scenarioActions.map((action) => ({ actionCode: action.actionCode, tradeoff: action.riskLevel === "LOW" ? "Low operational risk" : "Requires supervisor review" }))
  };
}

function actionLabel(action) {
  return `${action.actionCode || action.actionType}: ${action.capacityMinutes || action.quotaDeltaMinutes || 0} minutes`;
}

function scenarioComparisonScore(scenario) {
  return Math.max(0, 100 - Math.round(scenario.afterMetrics.capacityGapMinutes / 120) - Math.round(Math.abs(1 - scenario.afterMetrics.utilization) * 20));
}

function scenarioCapacityDelta(scenario) {
  return scenario.scenarioActions.reduce((total, action) => total + Number(action.capacityMinutes || 0), 0);
}

function reviewSummaryForScenario(scenario) {
  return `${scenario.scenarioName}: ${scenario.beforeMetrics.capacityGapMinutes} minutes gap before, ${scenario.afterMetrics.capacityGapMinutes} minutes gap after, residual risk ${scenario.residualRisk}. Recommended decision: ${scenario.recommendedDecision}.`;
}

function scenarioFromArgs(args) {
  const reviewPackage = args.reviewPackageId ? findReviewPackage(args.reviewPackageId) : null;
  const scenarioId = args.scenarioId || reviewPackage?.scenarioId;
  const scenario = state.workforceScenarios.find((item) => item.scenarioId === scenarioId);
  if (!scenario) throw new ToolError("scenario_not_found", "No scenario found for the supplied scenarioId or reviewPackageId.", args);
  return scenario;
}

function findReviewPackage(reviewPackageId) {
  const reviewPackage = state.reviewPackages.find((item) => item.reviewPackageId === reviewPackageId);
  if (!reviewPackage) throw new ToolError("review_package_not_found", `No review package found for ${reviewPackageId}.`);
  return reviewPackage;
}

function normalizeKnownEvent(input, eventId) {
  return {
    eventId,
    eventName: input.eventName,
    eventType: input.eventType || "other",
    startDate: input.startDate,
    endDate: input.endDate || input.startDate,
    areas: normalizeList(input.areas || input.area) || [],
    capacityCategories: normalizeList(input.capacityCategories || input.capacityCategory) || [],
    activityTypes: normalizeList(input.activityTypes || input.activityType) || [],
    skills: normalizeList(input.skills || input.skill) || [],
    impactDirection: input.impactDirection || "increase_workload",
    impactPercent: Number(input.impactPercent || 0),
    impactMinutes: Number(input.impactMinutes || 0),
    recurrence: input.recurrence || "none",
    notes: input.notes || "",
    createdBy: input.createdBy || "mock-planner",
    createdAt: input.createdAt || BASE_NOW,
    forecastAdjustmentState: input.forecastAdjustmentState || "proposed"
  };
}

function findKnownEvent(eventId) {
  const event = state.knownEvents.find((item) => item.eventId === eventId);
  if (!event) throw new ToolError("event_not_found", `No known event found for ${eventId}.`);
  return event;
}

function filterKnownEvents(args = {}) {
  const filters = expandDateRange(args);
  const dates = normalizeList(filters.dates || filters.date);
  return state.knownEvents.filter((event) =>
    (!dates || dates.some((date) => date >= event.startDate && date <= event.endDate)) &&
    matchAny(event.areas, normalizeList(filters.areas || filters.area)) &&
    matchAny(event.capacityCategories, normalizeList(filters.capacityCategories || filters.capacityCategory)) &&
    matchAny(event.activityTypes, normalizeList(filters.activityTypes || filters.activityType)) &&
    matchAny(event.skills, normalizeList(filters.skills || filters.skill)) &&
    matchList(event.eventId, normalizeList(args.eventIds || args.eventId)) &&
    matchList(event.forecastAdjustmentState, normalizeList(args.status))
  );
}

function eventSummary(event) {
  return pick(event, ["eventId", "eventName", "eventType", "startDate", "endDate", "areas", "capacityCategories", "impactPercent", "recurrence", "forecastAdjustmentState"]);
}

function ratio(numerator, denominator) {
  return Number((Number(numerator || 0) / Math.max(1, Number(denominator || 0))).toFixed(2));
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
      recordMcpEvent("sse.endpoint.sent", { sessionId, messageEndpoint });
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
  recordMcpEvent("sse.closed", { sessionId });
}

function recordMcpEvent(type, details = {}) {
  mcpEvents.push({
    sequence: mcpEvents.length + 1,
    at: new Date().toISOString(),
    type,
    details
  });
  if (mcpEvents.length > 200) {
    mcpEvents.splice(0, mcpEvents.length - 200);
  }
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

function knownEventSchema() {
  return {
    type: "object",
    properties: {
      eventName: { type: "string" },
      eventType: { type: "string" },
      startDate: { type: "string" },
      endDate: { type: "string" },
      areas: arrayOrString("Affected areas."),
      capacityCategories: arrayOrString("Affected capacity categories."),
      activityTypes: arrayOrString("Affected activity types."),
      skills: arrayOrString("Affected skills."),
      impactDirection: { type: "string" },
      impactPercent: { type: "number" },
      impactMinutes: { type: "number" },
      recurrence: { type: "string" },
      notes: { type: "string" },
      createdBy: { type: "string" }
    },
    required: ["eventName", "startDate"]
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
  if (Array.isArray(value) && value.length === 0) return null;
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
