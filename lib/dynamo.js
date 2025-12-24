const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// Initialize DynamoDB Client
const client = new DynamoDBClient({});

// Wrap with DocumentClient for JSON object abstraction
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

module.exports = docClient;
