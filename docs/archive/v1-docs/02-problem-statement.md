# 2. Problem Statement

## 2.1 The Context-Switching Tax

Modern software workflows require users to constantly switch contexts:

- A developer wants to create a GitHub issue but must remember the exact UI path: Repository → Issues → New Issue → Fill form → Submit
- A product manager needs to create a Jira ticket but must navigate: Project → Backlog → Create → Ticket type → Fields → Submit
- An employee must complete an expense report but must learn: Finance App → Expenses → New → Category → Receipt upload → Submit

Each of these workflows has documentation, but finding the right documentation takes time. Taking screenshots and asking AI takes time. Remembering the steps takes cognitive load.

## 2.2 The Limitations of Current AI Assistants

Current AI assistants (ChatGPT, Claude, Cursor) operate in a separate context:

1. **Screenshot dependency**: The user must capture the current screen, upload it, and describe what they want
2. **Static analysis**: The AI analyzes a single moment in time, not the workflow progression
3. **No visual anchoring**: The AI describes steps but doesn't highlight where to click
4. **No page observation**: The AI doesn't see what happens after a click
5. **Repeated context**: Every interaction requires re-establishing context

## 2.3 The Core Problem

The core problem is **actionable visual guidance**: Users need a system that understands their goal, sees what they see, identifies what to click, and confirms the result. Current tools require too much context-switching, manual input, and cognitive overhead.