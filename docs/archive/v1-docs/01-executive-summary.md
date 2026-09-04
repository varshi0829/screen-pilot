# 1. Executive Summary

ScreenPilot is a Chrome Extension that transforms how users interact with web applications. Rather than requiring users to search documentation, watch tutorials, or manually navigate complex interfaces, ScreenPilot acts as an intelligent GPS for software workflows.

The extension observes the current webpage, understands the user's stated goal, determines the next logical action, highlights the relevant UI element, and guides the user step-by-step until the goal is achieved. The user remains within their current context—no tab switching, no separate portal, no context loss.

The core innovation is proactive navigation: ScreenPilot doesn't answer questions or explain steps in a chat interface. Instead, it identifies targets in the DOM, highlights them visually, and waits for user confirmation through action. This creates a closed-loop feedback system where the AI observes page changes and adapts subsequent actions accordingly.

**Target Users**: Developers, product managers, and knowledge workers who regularly interact with web-based tools like GitHub, Jira, Gmail, Salesforce, and internal business applications.

**Technical Stack**: Chrome Extension (Manifest V3), Gemini API for reasoning, DOM-based element identification, vanilla JavaScript for the extension runtime.