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
