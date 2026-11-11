# Business logic

## Purpose

The reviewer helps developers assess code changes and produces findings tied
to source files. Developers can run it against a Git change in CI or start a
review of selected files from the dashboard.

## Rules

- In CI, findings should concern the selected change. Surrounding diff lines
  help explain the change.
- A finding at or above the configured severity fails the CI gate. An
  incomplete review also returns a failing exit code and retains the available
  results.
- A dashboard review uses the files selected by the review configuration
  inside the allowed review directory.
- The report lists findings from the model and sums the usage OpenCode
  reports. Missing usage data is marked as unavailable.
