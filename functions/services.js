/**
 * Service L1 - Full Capacity Mode
 * Throws error if event.error === true
 */
exports.serviceL1 = async (event) => {
  try {
    // Check if error simulation is requested
    if (event.error === true) {
      throw new Error('CRITICAL_FAILURE');
    }

    return {
      status: 200,
      level: 1,
      msg: 'Full Capacity',
    };
  } catch (error) {
    console.error('ServiceL1 Error:', error);
    throw error;
  }
};

/**
 * Service L2 - Degraded Mode
 * Ignores event.error flag
 */
exports.serviceL2 = async (event) => {
  try {
    return {
      status: 200,
      level: 2,
      msg: 'Degraded Mode',
    };
  } catch (error) {
    console.error('ServiceL2 Error:', error);
    throw error;
  }
};
