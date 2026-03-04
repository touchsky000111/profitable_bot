import mongoose from 'mongoose';
import chalk from 'chalk';
import config from '../config/index';

/**
 * Initialize MongoDB connection using Mongoose
 * @returns Promise<boolean> - Returns true if connection successful, false otherwise
 */
export const initMongoose = async (): Promise<boolean> => {
  // Check if DATABASE_URL is provided
  if (!config.DATABASE_URL) {
    console.error(chalk.red('✖') + ' DATABASE_URL is not configured in environment variables');
    return false;
  }

  try {
    // Set up connection event handlers before connecting
    mongoose.connection.on('connected', () => {
      console.log(chalk.green('✔') + ` Mongoose connected to MongoDB`);
    });

    mongoose.connection.on('error', (error) => {
      console.error(chalk.red('✖') + ' Mongoose connection error:', error.message);
    });

    mongoose.connection.on('disconnected', () => {
      console.log(chalk.yellow('⚠') + ' Mongoose disconnected from MongoDB');
    });

    // Handle process termination
    process.on('SIGINT', async () => {
      await mongoose.connection.close();
      console.log(chalk.yellow('⚠') + ' Mongoose connection closed due to application termination');
      process.exit(0);
    });

    // Connect to MongoDB
    await mongoose.connect(config.DATABASE_URL, {
      // Connection options for better reliability
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    return true;
  } catch (error: any) {
    console.error(
      chalk.red('✖') + ' Mongoose connection failed:',
      error.message || error
    );
    return false;
  }
};

export default initMongoose;
