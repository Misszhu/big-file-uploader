import { UploadStrategy, ConcurrentStrategyOptions, ChunkInfo, UploadResponse } from '../types';
import ChunkManager from '../core/ChunkManager';
import NetworkClient from '../core/NetworkClient';

class ConcurrentStrategy implements UploadStrategy {
  private chunkManager: ChunkManager;
  private networkClient: NetworkClient;
  private options: ConcurrentStrategyOptions;
  private lastReportedProgress: number = 0;
  private activeConnections: number = 0;
  private hashCalculated: boolean = false;
  private paused: boolean = false;
  private aborted: boolean = false;
  private abortController: AbortController | null = null;
  private pendingChunks: ChunkInfo[] = [];
  private retryQueue: ChunkInfo[] = [];
  private uploadId: string | null = null;

  constructor(options: ConcurrentStrategyOptions) {
    this.options = options;
    this.chunkManager = new ChunkManager(options.file, options.chunkSize);
    this.networkClient = new NetworkClient({
      baseURL: options.baseURL,
      endpoints: options.endpoints,
      headers: options.headers,
      timeout: options.timeout,
      withCredentials: options.withCredentials,
      maxRetries: options.maxRetries,
    });
  }

  /**
   * 执行上传流程
   */
  async execute(): Promise<void> {
    if (this.aborted) {
      throw new Error('Upload has been aborted');
    }

    this.abortController = new AbortController();

    try {
      // 1. 只在首次上传时计算哈希
      if (!this.hashCalculated) {
        await this.calculateFileHashWithProgress();
        this.hashCalculated = true;
      }

      // 2. 初始化或获取上传会话
      if (!this.uploadId) {
        const initResult = await this.initUploadSession();

        if ('exists' in initResult && initResult.exists) {
          this.options.onProgress(100);
          this.options.onSuccess(initResult);
          return;
        }

        // 检查 uploadId 是否存在
        if (!initResult.uploadId) {
          throw new Error('Missing uploadId in server response');
        }

        this.uploadId = initResult.uploadId;
      }


      // 3. 检查已上传的分片
      const progressInfo = await this.checkUploadProgress(this.uploadId);

      // 如果文件已完整上传
      if (progressInfo.isComplete) {
        this.options.onProgress(100);
        // 调用合并分片接口获取最终结果
        const result = await this.completeUpload(this.uploadId);
        this.options.onSuccess(result);
        return;
      }

      // 4. 标记已上传的分片为已完成
      if (progressInfo.uploadedChunks.length > 0) {
        progressInfo.uploadedChunks.forEach(index => {
          this.chunkManager.updateChunkStatus(index, 'completed');
        });
        // 更新进度时保存最后报告的进度
        const progress = Math.floor(20 + (progressInfo.uploadedChunks.length / this.chunkManager.chunks.length * 80));
        this.lastReportedProgress = progress;
        this.options.onProgress(progress);
      }

      // 5. 准备上传队列（只包含未完成的分片）
      this.prepareUploadQueue();

      // 6. 开始并发上传（仅上传未完成的分片）
      await this.processUploadQueue(this.uploadId);

      // 7. 合并分片
      const result = await this.completeUpload(this.uploadId);
      this.options.onSuccess(result);
    } catch (error) {
      this.handleUploadError(error);
    } finally {
      this.cleanup();
    }
  }

  pause(): void {
    this.paused = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  resume(): void {
    if (!this.paused) return;

    this.paused = false;
    this.abortController = new AbortController();
    // 1. 首先检查上传进度
    this.checkUploadProgress(this.uploadId!)
      .then(progressInfo => {
        // 2. 更新已上传分片状态
        if (progressInfo.uploadedChunks.length > 0) {
          progressInfo.uploadedChunks.forEach(index => {
            this.chunkManager.updateChunkStatus(index, 'completed');
          });
          this.updateBaseProgress();
        }

        // 3. 如果文件已完整上传，直接合并
        if (progressInfo.isComplete) {
          return this.completeUpload(this.uploadId!);
        }

        // 4. 否则继续上传剩余分片
        this.prepareUploadQueue();
        return this.processUploadQueue(this.uploadId!)
          .then(() => {
            if (!this.paused && !this.aborted) {
              return this.completeUpload(this.uploadId!);
            }
          });
      })
      .then(result => {
        if (result) {
          this.options.onSuccess(result);
        }
      })
      .catch(this.options.onError);
  }

  abort(): void {
    this.aborted = true;
    this.uploadId = null;
    this.hashCalculated = false;
    this.abortController?.abort();
    this.abortController = null;
    this.cleanup();
  }


  /**
   * 带进度回调的文件哈希计算
   */
  private async calculateFileHashWithProgress(): Promise<void> {
    try {
      await this.chunkManager.calculateFileHash((progress) => {
        // 哈希计算占总体进度的20%
        const overallProgress = Math.floor(progress * 0.2);
        this.options.onProgress(overallProgress);
      });
    } catch (error) {
      // 发生错误时重置进度为0
      this.options.onProgress(0);
      throw new Error(`File hash calculation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 初始化上传会话
   */
  private async initUploadSession(): Promise<UploadResponse> {
    try {
      return await this.networkClient.initUpload({
        fileName: this.options.file.name,
        fileSize: this.options.file.size,
        chunkSize: this.options.chunkSize,
        fileHash: this.chunkManager.fileHash!
      });

    } catch (error) {
      throw new Error(`Upload initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 准备上传队列
   */
  private prepareUploadQueue(): void {
    // 获取未完成的分片（排除已完成和上传中的分片）
    const completedIndices = this.chunkManager.getCompletedIndices();
    this.pendingChunks = this.chunkManager.getPendingChunks(completedIndices);

    // 添加需要重试的分片
    const chunksToRetry = this.chunkManager.getChunksToRetry(this.options.maxRetries);
    this.pendingChunks.push(...chunksToRetry);

    console.log(`准备上传队列: 待上传分片数 ${this.pendingChunks.length}`);
  }

  /**
   * 处理上传队列
   */
  private async processUploadQueue(uploadId: string): Promise<void> {
    while (this.shouldContinueProcessing()) {
      if (this.canStartNewConnection()) {
        const chunk = this.getNextChunk();
        if (chunk) {
          this.startChunkUpload(chunk, uploadId);
        }
      }

      // 避免阻塞事件循环
      await this.delay(50);
    }

    // 添加暂停检查
    if (this.paused) {
      return; // 暂停时直接返回，不执行后续操作
    }

    // 等待所有活跃连接完成
    await this.waitForActiveConnections();
  }

  /**
   * 启动分片上传
   */
  private async startChunkUpload(chunk: ChunkInfo, uploadId: string): Promise<void> {
    this.activeConnections++;
    this.chunkManager.updateChunkStatus(chunk.index, 'uploading');

    try {
      const formData = this.createFormData(chunk, uploadId);

      const response = await this.networkClient.uploadChunk(formData, {
        signal: this.abortController?.signal,
        onChunkProgress: (chunkProgress) => {
          this.updateChunkProgress(chunk.index, chunkProgress);
        }
      });
      // 处理分片上传成功
      this.handleChunkSuccess(chunk.index, response);
    } catch (error) {
      this.handleChunkError(chunk, error);
    } finally {
      this.activeConnections--;
      this.updateProgress();
    }
  }

  /**
   * 创建分片FormData
   */
  private createFormData(chunk: ChunkInfo, uploadId: string): FormData {
    const formData = new FormData();
    formData.append('file', chunk.blob);
    formData.append('chunkIndex', String(chunk.index));
    formData.append('fileHash', this.chunkManager.fileHash!);
    formData.append('uploadId', uploadId);
    return formData;
  }

  /**
   * 完成上传（合并分片）
   */
  private async completeUpload(uploadId: string): Promise<any> {
    // 添加暂停和中止检查
    if (this.paused || this.aborted) {
      throw new Error('Upload was paused or aborted');
    }

    try {
      return await this.networkClient.mergeChunks({
        uploadId,
        fileHash: this.chunkManager.fileHash!,
        fileName: this.options.file.name,
        totalChunks: this.chunkManager.chunks.length
      });
    } catch (error) {
      throw new Error(`File merge failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 处理上传错误
   */
  private handleUploadError(error: unknown): void {
    if (this.aborted) return;

    const errorMessage = error instanceof Error ? error.message : 'Unknown upload error';
    this.options.onError(new Error(errorMessage));
  }

  /**
   * 处理分片上传成功
   */
  private handleChunkSuccess(chunkIndex: number, response: any): void {
    this.chunkManager.updateChunkStatus(chunkIndex, 'completed');
    this.options.onChunkSuccess(chunkIndex, response);
  }

  /**
   * 处理分片上传失败
   */
  private handleChunkError(chunk: ChunkInfo, error: unknown): void {
    if (this.aborted) return;

    this.chunkManager.updateChunkStatus(chunk.index, 'failed');

    if (chunk.retries < this.options.maxRetries) {
      this.retryQueue.push(chunk); // 加入重试队列
    } else {
      console.error(`Chunk ${chunk.index} failed after ${this.options.maxRetries} retries`);
    }
  }

  private async checkUploadProgress(uploadId: string): Promise<{
    uploadedChunks: number[];
    isComplete: boolean;
  }> {
    try {
      const response = await this.networkClient.checkProgress(uploadId);
      return {
        uploadedChunks: response.uploadedChunks || [],
        isComplete: response.isComplete || false
      };
    } catch (error) {
      console.error('检查上传进度失败:', error);
      return {
        uploadedChunks: [],
        isComplete: false
      };
    }
  }

  /**
   * 更新分片上传进度
   */
  private updateChunkProgress(chunkIndex: number, chunkProgress: number): void {
    // 安全检查
    if (!this.chunkManager.chunks.length) {
      this.options.onProgress(0);
      return;
    }

    try {
      // 1. 获取已完成分片的进度
      const completedChunks = this.chunkManager.getCompletedIndices().length;
      const totalChunks = this.chunkManager.chunks.length;

      // 2. 计算基础进度（已完成分片）
      const baseProgress = (completedChunks / totalChunks) * 80;

      // 3. 计算当前上传分片的贡献
      const chunkWeight = 80 / totalChunks;
      const chunkContribution = (chunkProgress / 100) * chunkWeight;

      // 4. 计算总进度
      const overallProgress = Math.floor(20 + baseProgress + chunkContribution);

      // 5. 确保进度不会倒退
      const lastProgress = this.lastReportedProgress || 0;
      const safeProgress = Math.max(lastProgress, Math.min(100, overallProgress));

      // 6. 保存最后报告的进度
      this.lastReportedProgress = safeProgress;

      this.options.onProgress(safeProgress);
    } catch (error) {
      // 出错时不更新进度
      console.error('Error calculating progress:', error);
    }
  }

  private updateBaseProgress(): void {
    try {
      // 1. 如果没有哈希值或没有分片，进度为0
      if (!this.chunkManager.fileHash || !this.chunkManager.chunks.length) {
        this.options.onProgress(0);
        return;
      }

      // 2. 获取已完成分片数
      const completedChunks = this.chunkManager.getCompletedIndices().length;
      const totalChunks = this.chunkManager.chunks.length;

      // 3. 计算当前进度
      // 哈希计算(20%) + 已完成分片进度(80%)
      const progress = Math.floor(20 + (completedChunks / totalChunks * 80));

      // 4. 确保进度不会倒退
      const safeProgress = Math.max(this.lastReportedProgress, progress);
      this.lastReportedProgress = safeProgress;

      // 5. 更新进度
      this.options.onProgress(safeProgress);

      // 6. 添加日志
      console.log('更新基础进度:', {
        completedChunks,
        totalChunks,
        progress: safeProgress,
        hashCalculated: this.hashCalculated
      });
    } catch (error) {
      console.error('更新基础进度失败:', error);
    }
  }

  /**
   * 更新整体进度
   */
  private updateProgress(): void {
    try {
      // 如果没有哈希值或没有分片，进度为0
      if (!this.chunkManager.fileHash || !this.chunkManager.chunks.length) {
        this.options.onProgress(0);
        return;
      }

      // 直接计算完整进度
      const completedProgress = this.chunkManager.getProgress();
      const overallProgress = 20 + (completedProgress * 0.8);
      const safeProgress = Math.max(0, Math.min(100, Math.floor(overallProgress)));

      if (Number.isNaN(safeProgress)) {
        console.warn('Progress calculation resulted in NaN', {
          completedProgress,
          overallProgress
        });
        return;
      }

      this.options.onProgress(safeProgress);
    } catch (error) {
      // 出错时不更新进度
      console.error('Error calculating progress:', error);
    }
  }

  /**
   * 清理资源
   */
  private cleanup(): void {
    this.abortController = null;
    this.pendingChunks = [];
    this.retryQueue = [];
  }

  /**
   * 辅助方法：获取下一个分片
   */
  private getNextChunk(): ChunkInfo | undefined {
    return this.retryQueue.shift() || this.pendingChunks.shift();
  }

  /**
   * 辅助方法：检查是否可以启动新连接
   */
  private canStartNewConnection(): boolean {
    return this.activeConnections < this.options.concurrent &&
      (this.pendingChunks.length > 0 || this.retryQueue.length > 0);
  }

  /**
   * 辅助方法：是否应该继续处理
   */
  private shouldContinueProcessing(): boolean {
    return !this.paused &&
      !this.aborted &&
      (this.pendingChunks.length > 0 ||
        this.retryQueue.length > 0 ||
        this.activeConnections > 0);
  }

  /**
   * 辅助方法：等待活跃连接完成
   */
  private async waitForActiveConnections(): Promise<void> {
    while (this.activeConnections > 0 && !this.aborted) {
      await this.delay(100);
    }
  }

  /**
   * 辅助方法：延迟
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export default ConcurrentStrategy;