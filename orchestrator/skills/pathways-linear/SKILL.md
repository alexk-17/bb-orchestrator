---
name: pathways-linear
description: Implement Pathways Linear operations for mattpocock's wayfinder skill with native sub-issues and blocking relations.
---

# Pathways Linear operations

These are the Linear operations for mattpocock's `wayfinder` skill. The map is one issue in the orchestrator project's linked Linear project, labelled `wayfinder:map`. Its tickets are Linear sub-issues labelled exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`. Add `wayfinder:needs-you` to a ticket when its step requires the owner to sign in, approve, provide a secret, or make a payment. The map body has `## Destination`, `## Notes`, `## Decisions so far`, `## Not yet specified`, and `## Out of scope`, in that order. A ticket body starts with `## Question`.

Set `LINEAR_KEY_FILE` to the path of the secret file and keep it private. Every operation below uses the same curl transport; replace `QUERY` with the GraphQL operation shown, and pass variables as JSON. Keep the key out of logs, committed files, and reports.

```sh
curl -fsS https://api.linear.app/graphql \
  -H "Authorization: $(cat "$LINEAR_KEY_FILE")" \
  -H 'Content-Type: application/json' \
  --data-binary @request.json
```

Save one GraphQL block below as `operation.graphql`, then create `request.json` with `jq -n --rawfile query operation.graphql --arg mapId 'ISSUE_UUID' '{query:$query,variables:{mapId:$mapId}}'` for the frontier example. Use the same pattern with the named variables of each other operation. Inspect `.errors` and each mutation's `success`; HTTP success alone is insufficient. Use the linked project's `id` as `$projectId`, its team `id` as `$teamId`, and team workflow state IDs for open and completed states. Obtain the driving user with `query { viewer { id name } }`. Discover the project and states with:

```graphql
query($projectId: String!, $teamId: String!) {
  project(id: $projectId) { id name url teams { nodes { id } } }
  workflowStates(filter: { team: { id: { eq: $teamId } } }) {
    nodes { id name type }
  }
}
```

## Create the map

Create or find the six `wayfinder:` labels in the map's team. A label is team scoped; reuse its ID if the name already exists. Create a missing label with:

```graphql
mutation($teamId: String!, $name: String!) {
  issueLabelCreate(input: { teamId: $teamId, name: $name }) {
    success issueLabel { id name }
  }
}
```

Pass the full five-section Markdown body in `$body`. The initial `Decisions so far` section is empty.

```graphql
mutation($teamId: String!, $projectId: String!, $title: String!, $body: String!, $mapLabelId: String!, $openStateId: String!) {
  issueCreate(input: { teamId: $teamId, projectId: $projectId, title: $title,
    description: $body, labelIds: [$mapLabelId], stateId: $openStateId }) {
    success issue { id identifier title url }
  }
}
```

## Create child tickets and wire dependencies

Create each ticket with its type label ID and `parentId` set to the map's issue UUID. For a needs-you step, include both the type label ID and the `wayfinder:needs-you` label ID in `labelIds`. `$estimate` is optional: omit it when the decision cannot yet be sized.

```graphql
mutation($teamId: String!, $projectId: String!, $mapId: String!, $title: String!, $body: String!, $typeLabelId: String!, $openStateId: String!) {
  issueCreate(input: { teamId: $teamId, projectId: $projectId, parentId: $mapId,
    title: $title, description: $body, labelIds: [$typeLabelId], stateId: $openStateId }) {
    success issue { id identifier title url }
  }
}
```

To add or change a type label on an existing ticket, read all existing label IDs and send the complete desired set. Do not accidentally erase other labels:

```graphql
query($ticketId: String!) { issue(id: $ticketId) { id labels { nodes { id name } } } }
mutation($ticketId: String!, $labelIds: [String!]) {
  issueUpdate(id: $ticketId, input: { labelIds: $labelIds }) {
    success issue { id labels { nodes { id name } } }
  }
}
```

Create **all** issues first, then wire blocking edges and ticket cross-references in a second pass using their real UUIDs and URLs. Linear's relation source `issueId` blocks the target `relatedIssueId`; the target's `inverseRelations` shows its blockers. A blocker may be outside the map.

```graphql
mutation($blockerId: String!, $blockedId: String!) {
  issueRelationCreate(input: { type: blocks, issueId: $blockerId, relatedIssueId: $blockedId }) {
    success issueRelation { id type }
  }
}
```

## Frontier, claim, resolve

To find steps that need the owner, query the team label and inspect its open issues:

```graphql
query($labelId: String!) {
  issueLabel(id: $labelId) {
    issues(first: 100) {
      pageInfo { hasNextPage endCursor }
      nodes { id identifier title url state { type } parent { identifier } }
    }
  }
}
```

Page with `after` when `hasNextPage` is true. Keep only open children of the current map. Do not claim or resolve these steps for the owner.

Read the map's children and their incoming blockers. This single page covers up to 250 children and 250 blockers per child; if `hasNextPage` is true, repeat with `after` cursors before deciding the frontier. For a child's overflowing blockers, query that child separately with the relation-page query below. Do not silently treat a truncated result as complete. Map order here is child creation order, with UUID as a stable tie breaker.

```graphql
query($mapId: String!, $after: String) {
  issue(id: $mapId) {
    id identifier title
    children(first: 250, after: $after, orderBy: createdAt) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id identifier title createdAt assignee { id }
        state { type }
        inverseRelations(first: 250) {
          pageInfo { hasNextPage endCursor }
          nodes { type issue { id identifier state { type } } }
        }
      }
    }
  }
}
```

```graphql
query($ticketId: String!, $after: String) {
  issue(id: $ticketId) {
    inverseRelations(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { type issue { id identifier state { type } } }
    }
  }
}
```

For a complete response in `response.json`, list the frontier with:

```sh
jq -r '.data.issue.children.nodes
  | sort_by(.createdAt, .id)
  | .[]
  | select(.state.type != "completed" and .state.type != "canceled")
  | select(.assignee == null)
  | select([.inverseRelations.nodes[]
      | select(.type == "blocks")
      | select(.issue.state.type != "completed" and .issue.state.type != "canceled")]
      | length == 0)
  | [.identifier, .title] | @tsv' response.json
```

Claim the first frontier ticket by assigning it to the driving user **before** work. Requery immediately before claiming to handle concurrent sessions.

```graphql
mutation($ticketId: String!, $drivingUserId: String!) {
  issueUpdate(id: $ticketId, input: { assigneeId: $drivingUserId }) {
    success issue { id assignee { id } }
  }
}
```

Resolve one ticket per session (except research) by posting the answer, closing it, and appending a one-line gist and a title-wrapped ticket link under `## Decisions so far` in the map. Read the latest map description immediately before editing it; preserve the other sections and any decisions added by concurrent sessions. Re-read after updating to check the append survived.

```graphql
mutation($ticketId: String!, $answer: String!) {
  commentCreate(input: { issueId: $ticketId, body: $answer }) {
    success comment { id body }
  }
}
mutation($ticketId: String!, $completedStateId: String!) {
  issueUpdate(id: $ticketId, input: { stateId: $completedStateId }) {
    success issue { id state { type } }
  }
}
query($mapId: String!) { issue(id: $mapId) { id description updatedAt } }
mutation($mapId: String!, $body: String!) {
  issueUpdate(id: $mapId, input: { description: $body }) {
    success issue { id description updatedAt }
  }
}
```
