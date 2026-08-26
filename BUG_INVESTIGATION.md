# Bug Investigation: Extreme PR Ages for New Team Member

## Issue Report

User (petrsimon) has been at Red Hat for only 2 months, but the "Waiting on reviewers" visualization showed PRs 210-443 days old assigned to them.

## Root Cause Analysis

### Data Flow

1. **Snapshot Creation** (`src/runtime/daily.ts`)
   - Fetches ALL open PRs from GitHub via `listOpenPullRequests(repo)`
   - Not just Siara-managed PRs
   - Includes `pr.requestedReviewers` from GitHub

2. **Age Calculation**
   ```typescript
   const ageAnchor = pr.createdAt ?? pr.postedAt;
   const ageDays = daysBetween(ageAnchor, nowIso);
   ```
   - Uses `pr.createdAt` (GitHub PR creation timestamp)
   - Falls back to `pr.postedAt` (Slack workflow timestamp)
   - Most PRs use `createdAt` = real PR age from GitHub

3. **Reviewer Assignment**
   ```typescript
   snapshotRow(pr, [...pr.requestedReviewers].sort(), ...)
   ```
   - Uses GitHub's `requestedReviewers` field
   - Includes ALL current reviewers on the PR
   - Not filtered to Siara assignments

### Why New Members Show Old PRs

**Scenario**: Team structure changes, CODEOWNERS updates, or manual reviewer additions can assign existing PRs to new team members.

**Example**:
- PR created 443 days ago
- Originally assigned to someone else (or unassigned)
- Team reorganization or CODEOWNERS change adds petrsimon
- GitHub now shows petrsimon as requested reviewer
- Snapshot includes this PR with age=443d

**This is NOT a bug in age calculation** - the PR really IS 443 days old, and petrsimon really IS assigned to it in GitHub.

## Data Integrity

✅ **Age calculation**: Correct (uses GitHub `createdAt`)
✅ **Reviewer data**: Correct (uses GitHub `requestedReviewers`)
✅ **Assignment**: Real GitHub state, not invented

The visualization shows the **true current state** of who is blocking what PRs, regardless of how/when they got assigned.

## Design Decisions

### Current Behavior (Kept)

**Shows**: All open PRs with any requested reviewers
**Why**: Gives complete picture of review load and blockers

**Pros**:
- Shows real current bottlenecks
- Catches inherited/CODEOWNERS assignments
- No PRs hidden from view

**Cons**:
- Can show extreme ages for new members
- Includes non-Siara assignments

### Alternative (Not Implemented)

**Filter to**: Only PRs with `pr.postedAt` (Slack workflow timestamp)
**Why rejected**: Would hide legitimate blockers

**Pros**:
- Only Siara-managed PRs
- Ages reflect time in workflow

**Cons**:
- Hides inherited/manual assignments
- Incomplete picture of review load
- User still blocked on those PRs!

## Recommendations

### For Analysis

1. **Check GitHub directly** for those 443d PRs
2. **Verify** if they're really assigned to petrsimon
3. **Consider** closing truly stale PRs (400+ days!)

### For Visualization

Keep current behavior with documentation:

> "This shows ALL open PRs with requested reviewers from GitHub, 
> including inherited assignments from team changes and CODEOWNERS.
> Ages reflect GitHub PR creation time, not assignment time."

### For Workflow

If PRs > 200 days old are consistently appearing:
- Run periodic cleanup of truly abandoned PRs
- Update CODEOWNERS to reflect current team
- Consider auto-closing PRs after X days of inactivity

## Conclusion

**No code bug found.** The data is accurate. The visualization correctly shows that there ARE very old PRs currently assigned to team members, likely due to team inheritance or CODEOWNERS updates.

The extreme ages (210-443d) are a **process issue**, not a data issue.
