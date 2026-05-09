import assert from "node:assert/strict";
import test from "node:test";
import { callTool, handleHttpRequest, resetState } from "../src/mock-core.mjs";

test("lists tools through MCP", async () => {
  const response = await handleHttpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.result.tools.find((tool) => tool.name === "analyze_capacity_risk"));
  assert.ok(body.result.tools.find((tool) => tool.name === "move_activities"));
  assert.ok(body.result.tools.find((tool) => tool.name === "analyze_forecast_workforce_recommendations"));
  assert.ok(body.result.tools.find((tool) => tool.name === "simulate_workforce_scenario"));
  assert.ok(body.result.tools.find((tool) => tool.name === "create_known_event"));
  assert.ok(body.result.tools.find((tool) => tool.name === "get_workforce_management_insights"));
  assert.ok(body.result.tools.find((tool) => tool.name === "get_workforce_management_trends"));
  assert.ok(body.result.tools.find((tool) => tool.name === "get_workforce_management_actions"));
  assert.ok(body.result.tools.find((tool) => tool.name === "get_time_to_start_hire_recommendations"));
  assert.ok(body.result.tools.find((tool) => tool.name === "simulate_time_to_start_hire_impact"));
  assert.ok(body.result.tools.find((tool) => tool.name === "save_time_to_start_hire_proposal"));
});

test("supports StreamableHTTP MCP probes and text tool results", async () => {
  const probe = await handleHttpRequest(new Request("http://localhost/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream" }
  }));
  assert.equal(probe.status, 200);
  assert.match(probe.headers.get("content-type"), /text\/event-stream/);
  assert.match(await probe.text(), /endpoint/);

  const response = await handleHttpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "tools/call",
      params: { name: "analyze_capacity_risk", arguments: { limit: 1 } }
    })
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.content[0].type, "text");
  assert.ok(body.result.structuredContent.items[0].riskId.startsWith("RISK-"));
});

test("negotiates StreamableHTTP protocol and accepts notifications", async () => {
  const initialize = await handleHttpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" }
      }
    })
  }));
  assert.equal(initialize.status, 200);
  const initializeBody = await initialize.json();
  assert.equal(initializeBody.result.protocolVersion, "2025-03-26");
  assert.match(initialize.headers.get("access-control-allow-headers"), /mcp-protocol-version/);

  const notification = await handleHttpRequest(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("supports classic MCP SSE endpoint and message channel", async () => {
  await handleHttpRequest(new Request("http://localhost/mock/reset", { method: "POST" }));
  const sse = await handleHttpRequest(new Request("http://localhost/sse", {
    method: "GET",
    headers: { accept: "text/event-stream" }
  }));
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get("content-type"), /text\/event-stream/);
  const sessionId = sse.headers.get("mcp-session-id");
  assert.ok(sessionId);

  const reader = sse.body.getReader();
  const first = await reader.read();
  const endpointEvent = new TextDecoder().decode(first.value);
  assert.match(endpointEvent, /event: endpoint/);
  assert.match(endpointEvent, new RegExp(`/messages\\?sessionId=${sessionId}`));

  const message = await handleHttpRequest(new Request(`http://localhost/messages?sessionId=${sessionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "sse-1",
      method: "tools/list"
    })
  }));
  assert.equal(message.status, 202);

  const second = await reader.read();
  const messageEvent = new TextDecoder().decode(second.value);
  assert.match(messageEvent, /event: message/);
  assert.match(messageEvent, /"id":"sse-1"/);
  assert.match(messageEvent, /"tools"/);
  await reader.cancel();

  const eventsResponse = await handleHttpRequest(new Request("http://localhost/mock/mcp-events"));
  const events = await eventsResponse.json();
  assert.ok(events.events.some((event) => event.type === "sse.open"));
  assert.ok(events.events.some((event) => event.type === "sse.message.received" && event.details.method === "tools/list"));
});

test("analyzes seeded capacity risk", async () => {
  resetState();
  const result = await callTool("analyze_capacity_risk", { limit: 3 });
  assert.equal(result.items.length, 3);
  assert.ok(result.items.some((risk) => risk.riskLevel === "CRITICAL"));
  assert.ok(result.items[0].riskScore >= 40);
});

test("returns panel-ready heatmap cells", async () => {
  resetState();
  const result = await callTool("get_capacity_heatmap", {
    dateRange: { start: "2026-05-14", end: "2026-05-20" },
    limit: 5
  });
  assert.equal(result.items.length, 5);
  assert.ok(result.items[0].riskId.startsWith("RISK-"));
  assert.ok(["WATCH", "AT_RISK", "CRITICAL"].includes(result.items[0].riskState));
  assert.ok(result.items[0].recommendedNextAction);
});

test("blocks quota reduction below used quota by default", async () => {
  resetState();
  await assert.rejects(
    () => callTool("update_quota", {
      date: "2026-05-14",
      area: "NORTH",
      capacityCategory: "FIBER_INSTALL",
      timeSlot: "08:00-12:00",
      quotaMinutes: 1200
    }),
    /Quota cannot be reduced below used quota/
  );
});

test("moves recommended activities and updates state", async () => {
  resetState();
  const recommendation = await callTool("recommend_activity_rebalance", {
    riskId: "RISK-2026-05-14-NORTH-FIBER_INSTALL-08001200",
    maxCandidates: 2
  });
  assert.equal(recommendation.candidates.length, 2);

  const move = recommendation.candidates[0];
  const result = await callTool("move_activities", {
    moves: [{
      activityId: move.activityId,
      targetDate: move.recommendedTargetDate,
      targetTimeSlot: move.recommendedTargetTimeSlot,
      targetArea: move.recommendedTargetArea,
      targetResource: move.recommendedTargetResource
    }]
  });
  assert.equal(result.movedCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(result.moved[0].currentDate, move.recommendedTargetDate);
});

test("applies a recommended action bundle", async () => {
  resetState();
  const riskId = "RISK-2026-05-14-NORTH-FIBER_INSTALL-08001200";
  const result = await callTool("apply_recommended_action_bundle", {
    riskId,
    applyBookingControls: true,
    applyActivityMoves: false,
    sendCommunications: true,
    communications: [{
      audience: ["Booking Operations"],
      communicationType: "BOOKING_CONTROL_CHANGE_NOTICE",
      subject: "Mock bundle applied",
      message: "Quota and booking controls applied for the selected risk."
    }]
  });
  assert.equal(result.status, "applied");
  assert.equal(result.quotaUpdates.length, 1);
  assert.equal(result.bookingStatusUpdates.length, 1);
  assert.equal(result.closingScheduleUpdates.length, 1);
  assert.equal(result.communications.length, 1);
  assert.equal(result.stateUpdate.state, "applied");
});

test("returns forecast workforce recommendations and geography outlook", async () => {
  resetState();
  const recommendations = await callTool("analyze_forecast_workforce_recommendations", {
    dateRange: { start: "2026-05-14", end: "2026-05-21" },
    limit: 5
  });
  assert.ok(recommendations.items.length > 0);
  assert.ok(recommendations.items.some((item) => ["ADD_CAPACITY", "INVESTIGATE_PATTERN", "REDEPLOY_OR_RELEASE"].includes(item.recommendationType)));

  const outlook = await callTool("get_forecast_geography_outlook", {
    dateRange: { start: "2026-05-14", end: "2026-05-21" },
    geoLevel: "region"
  });
  assert.ok(outlook.items.length > 0);
  assert.ok(outlook.items[0].geographyKey);
  assert.ok(outlook.items[0].recommendedAction);
  assert.ok(outlook.resourceCrunchMap.svgDataUrl.startsWith("data:image/svg+xml;base64,"));
  assert.ok(outlook.resourceCrunchMap.demandDots.length > 0);
  assert.equal(outlook.forecastChart.chartWidgetConfig.type, "line");
  assert.ok(outlook.forecastChart.chartWidgetConfig.data.datasets.some((dataset) => dataset.label === "Forecasted Max Workload"));
  assert.ok(outlook.scheduleLeadTimeMatrix.rows.length >= 3);
});

test("returns Workforce Management insight panel data, charts, and actions", async () => {
  resetState();
  const insights = await callTool("get_workforce_management_insights", {});
  assert.deepEqual(insights.lookbackMonths, ["2026-02", "2026-03", "2026-04"]);
  assert.equal(insights.table.rows.length, 2);
  assert.ok(insights.table.rows.find((row) => row.capacityArea === "CA" && row.idleTimeMinutes > row.idleTimeTargetMinutes));
  assert.ok(insights.table.rows.find((row) => row.capacityArea === "FL" && row.timeToStartDays > row.timeToStartTargetDays));
  assert.equal(insights.charts.idleTime.chartWidgetConfig.type, "line");
  assert.equal(insights.charts.timeToStart.chartWidgetConfig.type, "line");
  assert.ok(insights.actions.find((action) => action.title === "Address resource idle time in CA"));
  assert.ok(insights.actions.find((action) => action.title === "Address increase in time to start activities in FL"));

  const trends = await callTool("get_workforce_management_trends", { metric: "idleTime", capacityAreas: ["CA"] });
  assert.deepEqual(trends.capacityAreas, ["CA"]);
  assert.ok(trends.charts.idleTime.chartWidgetConfig.data.datasets.some((dataset) => dataset.label === "CA Idle Time"));
  assert.equal(trends.charts.timeToStart, undefined);

  const actions = await callTool("get_workforce_management_actions", { issueTypes: ["TIME_TO_START"] });
  assert.deepEqual(actions.items.map((action) => action.capacityArea), ["FL"]);
  assert.equal(actions.items[0].buttonLabel, "Review recommendations");
});

test("supports FL time-to-start hire recommendation selection, simulation, and save", async () => {
  resetState();
  const recommendations = await callTool("get_time_to_start_hire_recommendations", {
    capacityArea: "FL",
    issueType: "TIME_TO_START"
  });
  assert.equal(recommendations.options.length, 3);
  assert.deepEqual(recommendations.options.map((option) => option.resourceId), [
    "FL-HIRE-001",
    "FL-HIRE-002",
    "FL-HIRE-003"
  ]);

  const none = await callTool("simulate_time_to_start_hire_impact", { capacityArea: "FL", selectedResourceIds: [] });
  assert.equal(none.impact.projectedAverageStartDays, 3.6);
  assert.equal(none.impact.projectedWithinSevenDaysPercent, 72);

  const one = await callTool("simulate_time_to_start_hire_impact", { capacityArea: "FL", selectedResourceIds: ["FL-HIRE-001"] });
  assert.equal(one.impact.projectedAverageStartDays, 3.2);
  assert.equal(one.impact.projectedWithinSevenDaysPercent, 75);

  const two = await callTool("simulate_time_to_start_hire_impact", { capacityArea: "FL", selectedResourceIds: ["FL-HIRE-001", "FL-HIRE-002"] });
  assert.equal(two.impact.projectedAverageStartDays, 2.7);
  assert.equal(two.impact.projectedWithinSevenDaysPercent, 80);
  assert.equal(two.chart.chartWidgetConfig.type, "line");

  const three = await callTool("simulate_time_to_start_hire_impact", { capacityArea: "FL", selectedResourceIds: ["FL-HIRE-001", "FL-HIRE-002", "FL-HIRE-003"] });
  assert.equal(three.impact.projectedAverageStartDays, 2.4);
  assert.equal(three.impact.projectedWithinSevenDaysPercent, 84);

  const saved = await callTool("save_time_to_start_hire_proposal", {
    capacityArea: "FL",
    selectedResourceIds: ["FL-HIRE-001", "FL-HIRE-002"]
  });
  assert.equal(saved.message, "Recommendation saved");
  assert.equal(saved.proposal.status, "SAVED");
  assert.equal(saved.proposal.proposedResourceCount, 2);
  assert.ok(saved.proposal.proposalId.startsWith("HIRE-FL-"));
});

test("supports demand event memory and forecast adjustment", async () => {
  resetState();
  const created = await callTool("create_known_event", {
    eventName: "Mock weekend sale",
    eventType: "sale",
    startDate: "2026-05-18",
    endDate: "2026-05-19",
    areas: ["EAST"],
    capacityCategories: ["INSPECTION"],
    impactPercent: 20,
    recurrence: "monthly"
  });
  assert.equal(created.event.eventName, "Mock weekend sale");

  const applied = await callTool("apply_forecast_event_adjustment", { eventId: created.event.eventId });
  assert.equal(applied.event.forecastAdjustmentState, "applied");
  assert.ok(applied.adjustedCount > 0);

  const removed = await callTool("remove_forecast_event_adjustment", { eventId: created.event.eventId });
  assert.ok(removed.restoredCount > 0);
});

test("simulates, reviews, applies, and rolls back workforce scenario", async () => {
  resetState();
  const recommendation = await callTool("analyze_forecast_workforce_recommendations", {
    dateRange: { start: "2026-05-14", end: "2026-05-21" },
    areas: ["NORTH"],
    capacityCategories: ["FIBER_INSTALL"],
    limit: 1
  });
  const simulation = await callTool("simulate_workforce_scenario", {
    recommendationId: recommendation.items[0].recommendationId,
    save: true
  });
  assert.ok(simulation.scenario.scenarioId.startsWith("SCN-"));

  const review = await callTool("create_workforce_review_package", {
    scenarioId: simulation.scenario.scenarioId,
    owner: "Ops Manager"
  });
  assert.equal(review.reviewPackage.scenarioId, simulation.scenario.scenarioId);

  const applied = await callTool("apply_workforce_scenario", {
    reviewPackageId: review.reviewPackage.reviewPackageId
  });
  assert.equal(applied.scenario.status, "applied");
  assert.ok(applied.updatedCellCount > 0);

  const rolledBack = await callTool("rollback_workforce_scenario", {
    scenarioId: simulation.scenario.scenarioId
  });
  assert.equal(rolledBack.scenario.status, "rolled_back");
  assert.ok(rolledBack.restoredCount > 0);
});
