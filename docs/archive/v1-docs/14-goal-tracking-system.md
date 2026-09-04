# 14. Goal Tracking System

## 14.1 Goal Decomposition

The AI decomposes the user's goal into a sequence of steps:

```
User Goal: "Create a GitHub issue about the login bug"

AI Decomposition:
┌─────────────────────────────────────────────────────────┐
│ Step 1: Navigate to repository issues page
│   - targetText: "Issues"
│   - action: "Click Issues tab"
│
│ Step 2: Open new issue form
│   - targetText: "New issue"
│   - action: "Click New issue button"
│
│ Step 3: Fill issue title
│   - targetText: "Title"
│   - action: "Enter 'Login bug in v2.3'"
│
│ Step 4: Fill issue description
│   - targetText: "Comment"
│   - action: "Enter description text"
│
│ Step 5: Submit issue
│   - targetText: "Submit issue"
│   - action: "Click submit button"
│
│ Complete: true
└─────────────────────────────────────────────────────────┘
```

## 14.2 Step Validation

After each user action, the system validates:

1. **Did the page change?** → If no, retry or abort
2. **Did we reach the expected state?** → If no, re-analyze
3. **Is the target element still present?** → If no, re-locate