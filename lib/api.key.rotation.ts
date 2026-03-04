import { Connection } from "@solana/web3.js";
import config from "../config/index";
/**
 * API Key Rotation Manager
 * Manages multiple API keys and rotates between them to avoid rate limits
 */
class APIKeyRotationManager {
  private apiKeys: string[];
  private currentIndex: number = 0;

  constructor(apiKeys: string[]) {
    // Filter out empty strings and ensure we have at least one API key
    this.apiKeys = apiKeys.filter(key => key.trim().length > 0);
    
    if (this.apiKeys.length === 0) {
    }
  }

  /**
   * Get the next API key in rotation (round-robin)
   */
  getNextApiKey(): string {
    const key = this.apiKeys[this.currentIndex];
    // Move to next index, wrap around if needed
    this.currentIndex = (this.currentIndex + 1) % this.apiKeys.length;
    return key;
  }

  /**
   * Get a specific API key by index (without rotation)
   */
  getApiKey(index: number): string {
    return this.apiKeys[index % this.apiKeys.length];
  }

  /**
   * Get the current API key (without advancing rotation)
   */
  getCurrentApiKey(): string {
    return this.apiKeys[this.currentIndex];
  }

  /**
   * Get the number of available API keys
   */
  getApiKeyCount(): number {
    return this.apiKeys.length;
  }

  /**
   * Get all API keys
   */
  getAllApiKeys(): string[] {
    return [...this.apiKeys];
  }
}

// Singleton instance - will be initialized in config
let shyftApiKeyManager: APIKeyRotationManager | null = null;

/**
 * Initialize the Shyft API key rotation manager
 * Should be called once at application startup
 */
export const initializeShyftAPIKeyRotation = (apiKeys: string[]): void => {
  shyftApiKeyManager = new APIKeyRotationManager(apiKeys);
};

/**
 * Initialize the API key rotation manager (backward compatibility - defaults to Shyft)
 * @deprecated Use initializeShyftAPIKeyRotation instead
 */
export const initializeAPIKeyRotation = (apiKeys: string[]): void => {
  initializeShyftAPIKeyRotation(apiKeys);
};

/**
 * Get the Shyft API key rotation manager instance
 */
export const getShyftAPIKeyRotationManager = (): APIKeyRotationManager => {
  if (!shyftApiKeyManager) {
    throw new Error("Shyft API Key Rotation Manager not initialized. Call initializeShyftAPIKeyRotation() first.");
  }
  return shyftApiKeyManager;
};

/**
 * Get the API key rotation manager instance (backward compatibility - defaults to Shyft)
 * @deprecated Use getShyftAPIKeyRotationManager instead
 */
export const getAPIKeyRotationManager = (): APIKeyRotationManager => {
  return getShyftAPIKeyRotationManager();
};

/**
 * Convenience function to get the next Shyft API key in rotation
 */
export const getNextRotatedShyftApiKey = (): string => {
  return getShyftAPIKeyRotationManager().getNextApiKey();
};

/**
 * Convenience function to get the next API key in rotation (backward compatibility - defaults to Shyft)
 * @deprecated Use getNextRotatedShyftApiKey instead
 */
export const getNextRotatedApiKey = (): string => {
  return getNextRotatedShyftApiKey();
};

/**
 * Extract API keys from RPC URLs
 */
export const extractApiKeysFromRpcUrls = (rpcUrls: string[]): string[] => {
  const apiKeys: string[] = [];
  
  for (const rpcUrl of rpcUrls) {
    // Match both api-key and api_key formats (case-insensitive)
    const apiKeyMatch = rpcUrl.match(/[?&]api[-_]key=([^&]+)/i);
    if (apiKeyMatch && apiKeyMatch[1]) {
      apiKeys.push(apiKeyMatch[1]);
    }
  }
  
  return apiKeys;
};

/**
 * Create a Solana Connection using rotated Shyft API key
 * This replaces the RPC rotation functionality by using API key rotation
 */
export const createRotatedConnection = (
  commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'
): Connection => {
  const apiKey = getNextRotatedShyftApiKey();
  const rpcUrl = `${config.RPC_URL}/?api_key=${apiKey}`;
  return new Connection(rpcUrl, commitment);
};

