const { UpdateCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const docClient = require('../lib/dynamo');

const TABLE_NAME = process.env.TABLE_NAME;
const PK = 'SYSTEM_STATE';

/**
 * CIRCUIT BREAKER THRESHOLDS
 * 
 * Degradation (fast - protect the system):
 *   L1 → L2: errorCount >= 5
 *   L2 → L3: errorCount >= 10
 * 
 * Promotion (slow - require proven stability):
 *   L2 → L1: Need RECOVERY_THRESHOLD consecutive successes
 *   L3 → L2: Need RECOVERY_THRESHOLD consecutive successes
 *   Any error resets the recovery counter
 */
const THRESHOLDS = {
  DEGRADE_TO_L2: 5,       // Degrade from L1 to L2
  DEGRADE_TO_L3: 10,      // Degrade from L2 to L3
  RECOVERY_POINTS: 10,    // Consecutive successes needed to promote
};

/**
 * Mutator - Atomic State Updates with Hysteresis
 * Handles FAILURE and SUCCESS actions with automatic level transitions
 * Uses different thresholds for degradation vs promotion to prevent oscillation
 */
exports.handler = async (event) => {
  const { action } = event;

  try {
    if (action === 'FAILURE') {
      return await handleFailure();
    } else if (action === 'SUCCESS') {
      return await handleSuccess(event);
    } else if (action === 'RESET') {
      return await handleReset();
    } else {
      throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    console.error('Mutator Error:', error);
    throw error;
  }
};

/**
 * Handle FAILURE action - Increment error count and potentially degrade level
 * Also resets recovery points (any error breaks the recovery streak)
 */
async function handleFailure() {
  const now = new Date().toISOString();

  // Atomic increment of errorCount and reset recoveryPoints
  const updateCommand = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK },
    UpdateExpression: 'SET errorCount = if_not_exists(errorCount, :zero) + :inc, recoveryPoints = :resetPoints, lastUpdated = :now',
    ExpressionAttributeValues: {
      ':inc': 1,
      ':zero': 0,
      ':resetPoints': 0,  // Reset recovery streak on any error
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  });

  const updateResult = await docClient.send(updateCommand);
  const newErrorCount = updateResult.Attributes.errorCount;
  let currentLevel = updateResult.Attributes.currentLevel || 1;

  // Determine new level based on error count thresholds (degradation only)
  // Note: We only degrade here, never promote on failure
  let newLevel = currentLevel;
  if (newErrorCount >= THRESHOLDS.DEGRADE_TO_L3 && currentLevel < 3) {
    newLevel = 3; // Maintenance
  } else if (newErrorCount >= THRESHOLDS.DEGRADE_TO_L2 && currentLevel < 2) {
    newLevel = 2; // Degraded
  }

  // Update level if it changed
  if (newLevel !== currentLevel) {
    const levelUpdateCommand = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK },
      UpdateExpression: 'SET currentLevel = :level, lastUpdated = :now',
      ExpressionAttributeValues: {
        ':level': newLevel,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    });

    const levelResult = await docClient.send(levelUpdateCommand);
    return {
      action: 'FAILURE',
      errorCount: newErrorCount,
      currentLevel: newLevel,
      levelChanged: true,
      lastUpdated: levelResult.Attributes.lastUpdated,
    };
  }

  return {
    action: 'FAILURE',
    errorCount: newErrorCount,
    currentLevel: currentLevel,
    levelChanged: false,
    lastUpdated: now,
  };
}

/**
 * Handle SUCCESS action - Accumulate recovery points and potentially promote level
 * 
 * PRODUCTION-GRADE BEHAVIOR:
 * - In L1: Decrement errorCount normally (forget old errors)
 * - In L2/L3: Accumulate recovery points ONLY for genuine successes
 *   (requests where the client did NOT send error=true)
 * - Promote only when recovery points reach threshold (proven stability)
 * - This prevents oscillation while allowing automatic recovery
 */
async function handleSuccess(event = {}) {
  const now = new Date().toISOString();
  
  // Check if the original request had the error flag set
  // If hadErrorFlag is true, this is a "protected" success (L2/L3 handling an error)
  // and should NOT count toward recovery
  const hadErrorFlag = event.hadErrorFlag === true;

  // Get current state
  const getCommand = new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK },
  });

  const getResult = await docClient.send(getCommand);
  
  if (!getResult.Item) {
    // No state exists, initialize with success
    const updateCommand = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK },
      UpdateExpression: 'SET errorCount = :zero, currentLevel = :level, recoveryPoints = :zero, lastUpdated = :now',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':level': 1,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    });

    await docClient.send(updateCommand);
    return {
      action: 'SUCCESS',
      errorCount: 0,
      currentLevel: 1,
      recoveryPoints: 0,
      levelChanged: false,
      lastUpdated: now,
    };
  }

  const currentErrorCount = getResult.Item.errorCount || 0;
  const currentLevel = getResult.Item.currentLevel || 1;
  const currentRecoveryPoints = getResult.Item.recoveryPoints || 0;

  let newErrorCount = currentErrorCount;
  let newLevel = currentLevel;
  let newRecoveryPoints = currentRecoveryPoints;

  if (currentLevel === 1) {
    // In Full Capacity (L1): decrement error count normally
    newErrorCount = Math.max(0, currentErrorCount - 1);
    newRecoveryPoints = 0; // Not needed in L1
  } else {
    // In Degraded/Maintenance (L2/L3): 
    if (hadErrorFlag) {
      // Client sent error=true but L2/L3 handled it gracefully
      // This still counts as system stress - increment errorCount
      // This allows the system to degrade further (L2→L3) if errors persist
      newErrorCount = currentErrorCount + 1;
      newRecoveryPoints = 0; // Reset recovery streak
      
      // Check if we should degrade further
      if (newErrorCount >= THRESHOLDS.DEGRADE_TO_L3 && currentLevel < 3) {
        newLevel = 3; // Degrade to Maintenance
      }
    } else {
      // Genuine success: client sent error=false and system handled it
      // This counts toward recovery
      newRecoveryPoints = currentRecoveryPoints + 1;
      
      // Check if we've reached the recovery threshold
      if (newRecoveryPoints >= THRESHOLDS.RECOVERY_POINTS) {
        // Promote one level and reset counters
        if (currentLevel === 3) {
          newLevel = 2; // Maintenance -> Degraded
        } else if (currentLevel === 2) {
          newLevel = 1; // Degraded -> Full
        }
        newErrorCount = 0;       // Reset error count on promotion
        newRecoveryPoints = 0;   // Reset recovery points
      }
    }
  }

  // Update state
  const updateCommand = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK },
    UpdateExpression: 'SET errorCount = :count, currentLevel = :level, recoveryPoints = :points, lastUpdated = :now',
    ExpressionAttributeValues: {
      ':count': newErrorCount,
      ':level': newLevel,
      ':points': newRecoveryPoints,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  });

  const updateResult = await docClient.send(updateCommand);

  return {
    action: 'SUCCESS',
    errorCount: newErrorCount,
    currentLevel: newLevel,
    recoveryPoints: newRecoveryPoints,
    levelChanged: newLevel !== currentLevel,
    lastUpdated: updateResult.Attributes.lastUpdated,
  };
}

/**
 * Handle RESET action - Reset system to Full Capacity
 * 
 * This is the manual recovery mechanism used in production systems.
 * After investigation and fix, operators can reset the circuit breaker.
 */
async function handleReset() {
  const now = new Date().toISOString();

  const updateCommand = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK },
    UpdateExpression: 'SET errorCount = :zero, currentLevel = :level, recoveryPoints = :zero, lastUpdated = :now',
    ExpressionAttributeValues: {
      ':zero': 0,
      ':level': 1,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  });

  await docClient.send(updateCommand);

  return {
    action: 'RESET',
    errorCount: 0,
    currentLevel: 1,
    recoveryPoints: 0,
    levelChanged: true,
    lastUpdated: now,
    message: 'System reset to Full Capacity',
  };
}
