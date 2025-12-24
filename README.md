# Resilient Service System

**Self-Healing Architecture with Circuit Breaker Pattern using AWS Step Functions Express**

[![AWS](https://img.shields.io/badge/AWS-Serverless-orange)](https://aws.amazon.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org/)
[![Serverless](https://img.shields.io/badge/Serverless-v4-red)](https://www.serverless.com/)

---

## 📋 Overview

Enterprise-grade resilient system implementing the **Circuit Breaker** pattern orchestrated by **AWS Step Functions Express**. The system automatically transitions between three operational levels based on error thresholds, providing:

- **Graceful Degradation**: Progressive reduction of capabilities under stress
- **Automatic Recovery**: Self-healing when stability is proven
- **Fault Tolerance**: Always responds, even during maintenance mode

---

## 🏗️ Architecture

### System Components

![Architecture Diagram](./docs/architecture-diagram.png)

### Step Functions Workflow

![Workflow Diagram](./docs/workflow-diagram.png)

---

## 🚦 Service Levels

| Level | Name | Description | Trigger |
|-------|------|-------------|---------|
| **1** | Full Capacity | All capabilities active | Default state |
| **2** | Degraded | Essential services only, ignores error flag | `errorCount >= 5` |
| **3** | Maintenance | Minimal operation, informative responses | `errorCount >= 10` |

### State Transitions

```
                    errorCount >= 5             errorCount >= 10
         ┌────────────────────────────┐   ┌────────────────────────────┐
         │                            ▼   │                            ▼
   ┌─────┴─────┐                ┌─────┴───────┐                ┌──────────────┐
   │  LEVEL 1  │                │   LEVEL 2   │                │   LEVEL 3    │
   │   FULL    │                │  DEGRADED   │                │ MAINTENANCE  │
   └─────▲─────┘                └──────▲──────┘                └──────┬───────┘
         │                             │                              │
         └─────────────────────────────┴──────────────────────────────┘
              recoveryPoints >= 10          recoveryPoints >= 10
```

### Recovery Mechanism (Hysteresis)

- **Degradation**: Fast (5 errors → L2, 10 errors → L3)
- **Recovery**: Slow (requires 10 consecutive genuine successes)
- Any error resets `recoveryPoints` to 0

---

## 🛠️ Technical Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js 20.x |
| Framework | Serverless Framework v4 |
| Orchestration | AWS Step Functions Express |
| Compute | AWS Lambda |
| Database | Amazon DynamoDB (PAY_PER_REQUEST) |
| API | Amazon API Gateway (REST) |
| SDK | AWS SDK v3 |

---

## 📁 Project Structure

```
resilient-service-system/
├── docs/
│   ├── architecture-diagram.png    # System architecture diagram
│   ├── workflow-diagram.png        # Step Functions workflow
│   ├── SRD.md                      # Software Requirements Document
│   └── ENTREGABLE_DOCUMENTACION_TECNICA.md
├── functions/
│   ├── api-handler.js              # API Gateway → Step Functions proxy
│   ├── get-state.js                # Reads current system state
│   ├── services.js                 # Service L1 and L2 handlers
│   └── mutator.js                  # State management and transitions
├── lib/
│   └── dynamo.js                   # DynamoDB client singleton
├── scripts/
│   └── k6-test.js                  # Load testing script
├── serverless.yml                  # Infrastructure as Code
├── package.json
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 20.0.0
- AWS CLI configured with credentials
- Serverless Framework v4

### Installation

```bash
# Clone repository
git clone https://github.com/ethx42/resilient-service-system.git
cd resilient-service-system

# Install dependencies
npm install

# Deploy to AWS (dev stage)
npx serverless deploy

# Deploy to production
npx serverless deploy --stage prod
```

### Configuration

Environment variables (auto-configured by Serverless):

| Variable | Description |
|----------|-------------|
| `TABLE_NAME` | DynamoDB table name |
| `STATE_MACHINE_ARN` | Step Functions ARN |

---

## 📊 DynamoDB Schema

**Table**: `ServiceResiliencyTable-{stage}`  
**Billing**: PAY_PER_REQUEST

| Attribute | Type | Description |
|-----------|------|-------------|
| `PK` | String | Partition Key: `"SYSTEM_STATE"` (Singleton) |
| `currentLevel` | Number | Current level: 1, 2, or 3 |
| `errorCount` | Number | Accumulated error count |
| `recoveryPoints` | Number | Consecutive genuine successes |
| `lastUpdated` | String | ISO 8601 timestamp |

---

## 🔄 Step Functions Workflow

```
Start
  │
  ▼
GetSystemState ──── Read currentLevel from DynamoDB
  │
  ▼
Router (Choice)
  │
  ├─ Level 1 ─────► TryServiceL1
  │                     │
  │                     ├─ Success ──► RegisterSuccess ──► SuccessResponse
  │                     │
  │                     └─ Catch ────► RegisterFailure ──► FailureResponse
  │
  ├─ Level 2 ─────► ServiceL2 ──► RegisterSuccess ──► SuccessResponse
  │
  └─ Default ─────► MaintenanceResponse (Choice)
                        │
                        ├─ error=true ──► MaintenanceErrorResponse ──► RegisterSuccess
                        │                 "Sistema bajo mantenimiento"
                        │
                        └─ error=false ─► MaintenanceSuccessResponse ─► RegisterSuccess
                                          "Operación al mínimo"
```

---

## 📝 API Reference

### POST /service-api

**Request:**

```json
{
  "error": false
}
```

### Responses by Level

| Level | Condition | Status | Response |
|-------|-----------|--------|----------|
| 1 | `error: false` | 200 | `{ "status": 200, "level": 1, "msg": "Full Capacity" }` |
| 1 | `error: true` | 500 | `{ "status": 500, "message": "Internal Server Error" }` |
| 2 | Any | 200 | `{ "status": 200, "level": 2, "msg": "Degraded Mode" }` |
| 3 | `error: false` | 200 | `{ "status": 200, "level": 3, "msg": "Nivel 3: Operación al mínimo" }` |
| 3 | `error: true` | 503 | `{ "status": 503, "level": 3, "msg": "Nivel 3: Sistema bajo mantenimiento, intente más tarde" }` |

---

## 🧪 Testing

### Load Testing with k6

The project includes a k6 script that simulates 6 minutes of load with error patterns:

```bash
# Install k6
brew install k6

# Run the test (update URL in scripts/k6-test.js first)
k6 run scripts/k6-test.js
```

**Test Distribution:**

| Minute | Errors | Expected Behavior |
|--------|--------|-------------------|
| 1 | 5/20 | Degrades to L2 |
| 2 | 0/20 | Accumulates recovery points |
| 3 | 15/20 | Degrades to L3 |
| 4 | 0/20 | Starts recovery |
| 5 | 15/20 | Maintains/degrades |
| 6 | 0/20 | Recovers to L1 |

### Manual Testing

```bash
# Success request
curl -X POST https://YOUR_API_URL/service-api \
  -H "Content-Type: application/json" \
  -d '{"error": false}'

# Error request (triggers degradation)
curl -X POST https://YOUR_API_URL/service-api \
  -H "Content-Type: application/json" \
  -d '{"error": true}'
```

---

## 🔍 Monitoring

### CloudWatch Logs

```bash
# Step Functions logs
aws logs tail /aws/vendedlogs/states/ServiceResiliencyWorkflow-dev --follow

# Lambda logs
aws logs tail /aws/lambda/resilient-service-system-dev-mutator --follow
```

### Key Metrics to Watch

- `currentLevel` in DynamoDB
- `errorCount` and `recoveryPoints`
- Step Functions execution duration
- Lambda invocation errors

---

## 🧹 Cleanup

```bash
# Remove all AWS resources
npx serverless remove

# Remove specific stage
npx serverless remove --stage prod
```

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [SRD.md](./docs/SRD.md) | Software Requirements Document |
| [ENTREGABLE_DOCUMENTACION_TECNICA.md](./docs/ENTREGABLE_DOCUMENTACION_TECNICA.md) | Technical Documentation (Spanish) |

---

## 🔐 Security

- **IAM**: Least-privilege principle
- **DynamoDB**: Access restricted to specific operations
- **API Gateway**: CORS enabled
- **No hardcoded secrets**: Environment variables only

---

## 🏛️ Architecture Patterns

| Pattern | Implementation |
|---------|----------------|
| **Circuit Breaker** | Step Functions Router with state-based routing |
| **Graceful Degradation** | 3 service levels with decreasing functionality |
| **Health Monitoring** | Atomic counters in DynamoDB |
| **Self-Healing** | Automatic recovery via recoveryPoints |
| **Hysteresis** | Asymmetric thresholds prevent oscillation |

---

## 📄 License

MIT

---

**Author**: Santiago Torres Guevara  
**Version**: 3.0.0  
**Last Updated**: December 2025
