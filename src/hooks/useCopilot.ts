"use client";

import { useState, useCallback } from "react";

export interface CurrentState {
  application: string;
  pageType: string;
  authenticated: boolean;
  currentActivity: string;
  confidence: number;
}

export interface DestinationState {
  application: string;
  goal: string;
}

export interface GapAnalysis {
  blockers: string[];
  missingPrerequisites: string[];
  navigationRequired: boolean;
  transitions: string[];
}

export interface ExecutionResult {
  nextAction: string;
  expectedState: {
    url?: string;
    pageType?: string;
  };
  verification: {
    urlChanged: boolean;
    domChanged: boolean;
    pageTypeChanged: boolean;
  };
  replan: boolean;
}

export type CopilotStatus = "idle" | "analyzing" | "executing" | "verifying" | "complete" | "blocked" | "error";

export interface CopilotState {
  status: CopilotStatus;
  currentState: CurrentState | null;
  destinationState: DestinationState | null;
  gapAnalysis: GapAnalysis | null;
  nextAction: string | null;
  error: string | null;
  completedSteps: string[];
}

const initialState: CopilotState = {
  status: "idle",
  currentState: null,
  destinationState: null,
  gapAnalysis: null,
  nextAction: null,
  error: null,
  completedSteps: [],
};

export function useCopilot() {
  const [state, setState] = useState<CopilotState>(initialState);

  const analyze = useCallback(async (screenshot: { image: string; mimeType?: string }, goal: string) => {
    setState((prev) => ({ ...prev, status: "analyzing", error: null }));

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ screenshot, goal }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Analysis failed");
      }

      const data = await response.json();
      
      // Parse Gemini response
      const result = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "{}");
      
      // Extract state detection
      const currentState: CurrentState = {
        application: result.application || "Unknown",
        pageType: result.pageType || "other",
        authenticated: result.screenSummary?.toLowerCase().includes("signed in") ?? false,
        currentActivity: result.currentStep || "",
        confidence: result.confidence || 0.5,
      };

      // Extract gap analysis from plan
      const gapAnalysis: GapAnalysis = {
        blockers: result.blockers || [],
        missingPrerequisites: result.missingPrerequisites || [],
        navigationRequired: result.navigationRequired || false,
        transitions: result.plan?.map((p: { description: string }) => p.description) || [],
      };

      // Extract next action
      const nextAction = result.instruction || "";

      setState((prev) => ({
        ...prev,
        status: nextAction ? "executing" : "complete",
        currentState,
        destinationState: { application: currentState.application, goal },
        gapAnalysis,
        nextAction,
      }));

      return { currentState, gapAnalysis, nextAction };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      setState((prev) => ({ ...prev, status: "error", error }));
      throw err;
    }
  }, []);

  const executeStep = useCallback(async (screenshot: { image: string; mimeType?: string }) => {
    setState((prev) => ({ ...prev, status: "verifying" }));

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          screenshot,
          goal: "continue",
          taskState: {
            completedSteps: state.completedSteps,
            currentInstruction: state.nextAction,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Execution failed");
      }

      const data = await response.json();
      const result = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text || "{}");

      // Check for blockers
      if (result.blockers?.length > 0) {
        setState((prev) => ({
          ...prev,
          status: "blocked",
          error: result.blockers[0],
        }));
        return { blocked: true, blocker: result.blockers[0] };
      }

      // Verify state change
      const verification = {
        urlChanged: result.urlChanged || false,
        domChanged: result.domChanged || false,
        pageTypeChanged: result.pageTypeChanged || false,
      };

      // Check if task is complete
      if (result.currentStep === "Task complete" || result.confidence === 1) {
        setState((prev) => ({
          ...prev,
          status: "complete",
          nextAction: null,
          completedSteps: [...prev.completedSteps, prev.nextAction!].filter(Boolean),
        }));
        return { complete: true };
      }

      // Replan if needed
      if (!verification.urlChanged && !verification.domChanged && !verification.pageTypeChanged) {
        setState((prev) => ({ ...prev, status: "analyzing", replan: true }));
        return { replan: true };
      }

      // Continue with next step
      const nextAction = result.instruction || "";
      setState((prev) => ({
        ...prev,
        status: nextAction ? "executing" : "complete",
        nextAction,
        completedSteps: [...prev.completedSteps, prev.nextAction!].filter(Boolean),
      }));

      return { nextAction, verification };
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      setState((prev) => ({ ...prev, status: "error", error }));
      throw err;
    }
  }, [state.completedSteps, state.nextAction]);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    state,
    analyze,
    executeStep,
    reset,
  };
}