"use client";

import { useState, useCallback } from "react";
import { useCopilot, CopilotStatus } from "@/hooks/useCopilot";

export default function Copilot() {
  const [goal, setGoal] = useState("");
  const [screenshot, setScreenshot] = useState<{ image: string; mimeType?: string } | null>(null);
  const { state, analyze, executeStep, reset } = useCopilot();

  const handleGoalSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim() || !screenshot) return;
    await analyze(screenshot, goal);
  }, [goal, screenshot, analyze]);

  const handleExecute = useCallback(async () => {
    if (!screenshot) return;
    await executeStep(screenshot);
  }, [screenshot, executeStep]);

  const handleScreenshotCapture = useCallback(() => {
    // This would be connected to the browser extension in production
    // For now, just a placeholder
    console.log("Capture screenshot from extension");
  }, []);

  const getStatusColor = (status: CopilotStatus): string => {
    switch (status) {
      case "idle": return "bg-gray-200";
      case "analyzing": return "bg-yellow-200";
      case "executing": return "bg-blue-200";
      case "verifying": return "bg-purple-200";
      case "complete": return "bg-green-200";
      case "blocked": return "bg-red-200";
      case "error": return "bg-red-200";
      default: return "bg-gray-200";
    }
  };

  const getStatusLabel = (status: CopilotStatus): string => {
    switch (status) {
      case "idle": return "Ready";
      case "analyzing": return "Analyzing...";
      case "executing": return "Executing...";
      case "verifying": return "Verifying...";
      case "complete": return "Complete";
      case "blocked": return "Blocked";
      case "error": return "Error";
      default: return "Ready";
    }
  };

  return (
    <div className="fixed bottom-4 right-4 w-80 bg-white rounded-lg shadow-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">ScreenPilot</h3>
        <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(state.status)}`}>
          {getStatusLabel(state.status)}
        </span>
      </div>

      {/* Goal Input */}
      <form onSubmit={handleGoalSubmit} className="p-4 border-b border-gray-200">
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="What do you want to do?"
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={handleScreenshotCapture}
            className="px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 rounded-md transition-colors"
          >
            Capture
          </button>
          <button
            type="submit"
            disabled={!goal.trim() || state.status === "analyzing"}
            className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50"
          >
            Go
          </button>
        </div>
      </form>

      {/* Current State Display */}
      {state.currentState && (
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="text-xs text-gray-500 mb-1">Current State</div>
          <div className="flex gap-2">
            <span className="px-2 py-1 bg-gray-100 rounded text-xs font-medium">
              {state.currentState.application}
            </span>
            <span className="px-2 py-1 bg-gray-100 rounded text-xs">
              {state.currentState.pageType}
            </span>
            {!state.currentState.authenticated && (
              <span className="px-2 py-1 bg-red-100 rounded text-xs text-red-700">
                Not signed in
              </span>
            )}
          </div>
        </div>
      )}

      {/* Next Action */}
      {state.nextAction && (
        <div className="px-4 py-3 border-b border-gray-200">
          <div className="text-xs text-gray-500 mb-1">Next Action</div>
          <p className="text-sm font-medium text-gray-800">{state.nextAction}</p>
          <button
            onClick={handleExecute}
            disabled={state.status === "executing" || state.status === "verifying"}
            className="mt-2 w-full px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded-md text-sm transition-colors disabled:opacity-50"
          >
            {state.status === "executing" ? "Executing..." : "Do This"}
          </button>
        </div>
      )}

      {/* Blocked State */}
      {state.status === "blocked" && state.error && (
        <div className="px-4 py-3 bg-red-50 border-b border-gray-200">
          <div className="text-xs text-red-600 mb-1">Blocked</div>
          <p className="text-sm text-red-700">{state.error}</p>
        </div>
      )}

      {/* Error State */}
      {state.status === "error" && state.error && (
        <div className="px-4 py-3 bg-red-50 border-b border-gray-200">
          <p className="text-sm text-red-700">{state.error}</p>
        </div>
      )}

      {/* Completed Steps */}
      {state.completedSteps.length > 0 && (
        <div className="px-4 py-3">
          <div className="text-xs text-gray-500 mb-1">
            Completed ({state.completedSteps.length})
          </div>
          <ul className="text-xs text-gray-600 space-y-1">
            {state.completedSteps.map((step, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="text-green-500">✓</span>
                {step}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Reset */}
      {(state.status === "complete" || state.status === "blocked" || state.status === "error") && (
        <div className="px-4 py-3 border-t border-gray-200">
          <button
            onClick={reset}
            className="w-full px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-md text-sm transition-colors"
          >
            New Goal
          </button>
        </div>
      )}
    </div>
  );
}