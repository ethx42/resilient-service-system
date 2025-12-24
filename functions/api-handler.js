const { SFNClient, StartSyncExecutionCommand } = require('@aws-sdk/client-sfn');

const sfnClient = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

/**
 * API Handler - Invokes Step Function synchronously
 * Acts as a proxy between API Gateway and Step Functions Express
 */
exports.handler = async (event) => {
  try {
    // Parse the incoming request body
    const input = event.body ? JSON.parse(event.body) : {};

    // Start synchronous execution of the Step Function
    const command = new StartSyncExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      input: JSON.stringify(input),
    });

    const result = await sfnClient.send(command);

    // Check execution status
    if (result.status === 'SUCCEEDED') {
      const output = JSON.parse(result.output);
      return {
        statusCode: output.status || 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify(output),
      };
    } else {
      // Execution failed
      console.error('Step Function execution failed:', result);
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          status: 500,
          message: 'Step Function execution failed',
          error: result.error,
          cause: result.cause,
        }),
      };
    }
  } catch (error) {
    console.error('API Handler Error:', error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        status: 500,
        message: 'Internal Server Error',
        error: error.message,
      }),
    };
  }
};

