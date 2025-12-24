# Software Requirements Document (SRD)

**Project:** Resilient Service System  
---

## 1. Overview

Sistema de arquitectura resiliente con degradación progresiva y recuperación automática basado en el patrón Circuit Breaker.

**Stack:** AWS Serverless (Node.js 20.x, DynamoDB, Step Functions Express, Serverless Framework v4)

---

## 2. Technical Dependencies

| Component | Specification                                                              |
| --------- | -------------------------------------------------------------------------- |
| Runtime   | `nodejs20.x`                                                               |
| Framework | `serverless` (>= 4.0.0)                                                    |
| Plugin    | `serverless-step-functions`                                                |
| AWS SDK   | `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-sfn` |

---

## 3. System Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────────────┐
│     Client      │────▶│   API Gateway   │────▶│      api-handler (Lambda)       │
└─────────────────┘     └─────────────────┘     └───────────────┬─────────────────┘
                                                                │
                                                                ▼
                              ┌──────────────────────────────────────────────────┐
                              │         Step Functions Express (Sync)            │
                              │                                                  │
                              │  GetSystemState → Router → Service (L1/L2/L3)    │
                              │                     ↓                            │
                              │            RegisterSuccess / RegisterFailure     │
                              └───────────────────────┬──────────────────────────┘
                                                      │
                                                      ▼
                              ┌──────────────────────────────────────────────────┐
                              │                   DynamoDB                       │
                              │            ServiceResiliencyTable                │
                              └──────────────────────────────────────────────────┘
```

---

## 4. Service Levels

| Level | Name        | Behavior                      | Response                                          |
| ----- | ----------- | ----------------------------- | ------------------------------------------------- |
| 1     | Full        | Processes all requests        | `{ status: 200, level: 1, msg: "Full Capacity" }` |
| 2     | Degraded    | Ignores error flag, always OK | `{ status: 200, level: 2, msg: "Degraded Mode" }` |
| 3     | Maintenance | Returns maintenance message   | See below                                         |

### Level 3 Responses

| Request Condition | Status | Message                                                    |
| ----------------- | ------ | ---------------------------------------------------------- |
| `error: true`     | 503    | `"Nivel 3: Sistema bajo mantenimiento, intente más tarde"` |
| `error: false`    | 200    | `"Nivel 3: Operación al mínimo"`                           |

---

## 5. State Transition Logic

### Thresholds

```javascript
const THRESHOLDS = {
  DEGRADE_TO_L2: 5,
  DEGRADE_TO_L3: 10,
  RECOVERY_POINTS: 10,
};
```

### Degradation Rules

- **L1 → L2**: `errorCount >= 5`
- **L2 → L3**: `errorCount >= 10`
- Any error resets `recoveryPoints` to 0

### Recovery Rules

- **L3 → L2**: `recoveryPoints >= 10`
- **L2 → L1**: `recoveryPoints >= 10`
- Only genuine successes (`error: false`) accumulate recovery points
- Promotion resets both `errorCount` and `recoveryPoints`

---

## 6. Data Model (DynamoDB)

**Table:** `ServiceResiliencyTable-${stage}`  
**Billing:** PAY_PER_REQUEST

| Attribute        | Type   | Description                       |
| ---------------- | ------ | --------------------------------- |
| `PK`             | String | `"SYSTEM_STATE"` (Singleton)      |
| `currentLevel`   | Number | 1 (Full), 2 (Degraded), 3 (Maint) |
| `errorCount`     | Number | Accumulated error count           |
| `recoveryPoints` | Number | Consecutive genuine successes     |
| `lastUpdated`    | String | ISO 8601 timestamp                |

---

## 7. Component Specifications

### `lib/dynamo.js`

- Singleton DynamoDBDocumentClient
- Config: `removeUndefinedValues: true`

### `functions/api-handler.js`

- Entry point for API Gateway
- Invokes Step Function via `StartSyncExecutionCommand`
- Returns formatted response with CORS headers

### `functions/get-state.js`

- Reads current state from DynamoDB
- Returns default `{ currentLevel: 1, errorCount: 0 }` if no record exists

### `functions/services.js`

**serviceL1:**

- Throws `Error("CRITICAL_FAILURE")` if `event.error === true`
- Returns success response otherwise

**serviceL2:**

- Ignores `event.error` flag
- Always returns success response

### `functions/mutator.js`

| Action    | Behavior                                                          |
| --------- | ----------------------------------------------------------------- |
| `FAILURE` | Increments `errorCount`, resets `recoveryPoints`, evaluates level |
| `SUCCESS` | Manages recovery based on `hadErrorFlag` and current level        |
| `RESET`   | Resets system to Level 1                                          |

---

## 8. Workflow States (Step Functions)

| State                        | Type   | Description                            |
| ---------------------------- | ------ | -------------------------------------- |
| `GetSystemState`             | Task   | Invokes get-state Lambda               |
| `Router`                     | Choice | Routes by `$.systemState.currentLevel` |
| `TryServiceL1`               | Task   | Invokes serviceL1 with error Catch     |
| `ServiceL2`                  | Task   | Invokes serviceL2                      |
| `MaintenanceResponse`        | Choice | Routes by `$.error`                    |
| `MaintenanceErrorResponse`   | Pass   | Returns maintenance error message      |
| `MaintenanceSuccessResponse` | Pass   | Returns minimal operation message      |
| `RegisterFailure`            | Task   | Invokes mutator with `action: FAILURE` |
| `RegisterSuccess`            | Task   | Invokes mutator with `action: SUCCESS` |
| `FailureResponse`            | Pass   | Returns 500 error                      |
| `SuccessResponse`            | Pass   | Returns success response               |

---

## 9. IAM Requirements

```yaml
statements:
  - Effect: Allow
    Action:
      - dynamodb:GetItem
      - dynamodb:UpdateItem
      - dynamodb:PutItem
    Resource: !GetAtt ServiceResiliencyTable.Arn
  - Effect: Allow
    Action:
      - states:StartSyncExecution
    Resource: !Sub arn:aws:states:${AWS::Region}:${AWS::AccountId}:stateMachine:ServiceResiliencyWorkflow-${sls:stage}
```

---

## 10. Observability

### CloudWatch Logs

- Step Functions: `/aws/vendedlogs/states/ServiceResiliencyWorkflow-${stage}`
- Lambdas: `/aws/lambda/{function-name}`

### Key Metrics

- `errorCount` (DynamoDB)
- `currentLevel` (DynamoDB)
- `recoveryPoints` (DynamoDB)
- Step Functions execution duration
- Lambda invocation count/errors
