const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const docClient = require('../lib/dynamo');

const TABLE_NAME = process.env.TABLE_NAME;
const PK = 'SYSTEM_STATE';

exports.handler = async (event) => {
  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK },
    });

    const result = await docClient.send(command);

    // If no record exists, return default state
    if (!result.Item) {
      return {
        currentLevel: 1,
        errorCount: 0,
      };
    }

    return {
      currentLevel: result.Item.currentLevel,
      errorCount: result.Item.errorCount,
      lastUpdated: result.Item.lastUpdated,
    };
  } catch (error) {
    console.error('Error fetching system state:', error);
    throw error;
  }
};
