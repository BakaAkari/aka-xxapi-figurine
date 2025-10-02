import { Context, Schema, h } from 'koishi'
import * as path from 'path'

export const name = 'aka-xxapi-figurine'

export interface Config {
  apiKey: string
  cooldownTime: number
  apiTimeout: number
  maxImageSize: number
  enableLog: boolean
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required().description('手办化API密钥'),
  cooldownTime: Schema.number().default(30).min(5).max(300).description('等待发送图片的时间(秒)'),
  apiTimeout: Schema.number().default(120).min(30).max(300).description('API请求超时时间(秒)'),
  maxImageSize: Schema.number().default(10).min(1).max(50).description('最大图片大小限制(MB)'),
  enableLog: Schema.boolean().default(true).description('启用日志记录')
})

interface FigurineResponse {
  code: number
  msg: string
  data: string
  request_id: string
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('aka-xxapi-figurine')
  const waitingImages: Map<string, { style: number, timeout: NodeJS.Timeout }> = new Map()
  const processingUsers: Set<string> = new Set()

  // 验证API密钥配置
  if (!config.apiKey || config.apiKey.trim() === '') {
    logger.error('手办化模块: API密钥未配置或为空')
    return
  }


  // 日志函数
  function logInfo(message: string, data?: any) {
    if (config.enableLog && logger) {
      logger.info(message, data)
    }
  }

  function logError(message: string, error?: any) {
    if (config.enableLog && logger) {
      logger.error(message, error)
    }
  }

  // 获取图片URL - 参考yunwu插件的实现
  async function getImageUrl(img: any, session: any): Promise<string | null> {
    let url: string | null = null
    
    // 方法1：从命令参数获取图片
    if (img) {
      url = img.attrs?.src || null
      if (url) {
        logInfo('手办化模块: 从命令参数获取图片', { url })
        return url
      }
    }
    
    // 方法2：从引用消息获取图片
    let elements = session.quote?.elements
    if (elements) {
      const images = h.select(elements, 'img')
      if (images.length > 0) {
        url = images[0].attrs.src
        logInfo('手办化模块: 从引用消息获取图片', { url })
        return url
      }
    }
    
    // 方法3：从session.elements获取图片（备用方案）
    elements = session.elements
    if (elements) {
      const images = h.select(elements, 'img')
      if (images.length > 0) {
        url = images[0].attrs.src
        logInfo('手办化模块: 从session元素获取图片', { url })
        return url
      }
    }
    
    // 方法4：等待用户发送图片
    await session.send('请在30秒内发送一张图片')
    const msg = await session.prompt(30000)
    
    if (!msg) {
      await session.send('等待超时')
      return null
    }
    
    // 解析用户发送的消息
    elements = h.parse(msg)
    const images = h.select(elements, 'img')
    
    if (images.length === 0) {
      await session.send('未检测到图片，请重试')
      return null
    }
    
    url = images[0].attrs.src
    logInfo('手办化模块: 从用户输入获取图片', { url })
    return url
  }

  // 提取图片 - 兼容旧版本调用
  function extractImages(session: any): string[] {
    const images: string[] = []
    
    // 优先从session.quote?.elements获取图片
    let elements = session.quote?.elements
    if (!elements) {
      // 如果没有quote，则从session.elements获取
      elements = session.elements
    }
    
    if (elements) {
      const imgElements = h.select(elements, 'img')
      
      for (const img of imgElements) {
        const imageUrl = img.attrs?.src
        if (imageUrl) {
          images.push(imageUrl)
          logInfo('手办化模块: 从img.attrs.src提取到图片直链', { 
            extractedUrl: imageUrl,
            urlLength: imageUrl.length,
            fileName: img.attrs?.file || 'unknown',
            fileSize: img.attrs?.fileSize || 'unknown',
            subType: img.attrs?.subType || 'unknown',
            source: session.quote?.elements ? 'quote' : 'session'
          })
        }
      }
    }
    
    logInfo('手办化模块: 图片提取结果', { 
      totalImages: images.length,
      hasQuote: !!session.quote?.elements,
      hasElements: !!session.elements,
      elementsCount: elements?.length || 0,
      extractedImages: images.map((url, index) => ({
        index: index + 1,
        url: url,
        urlLength: url.length,
        isQQImage: url.includes('gchat.qpic.cn') || url.includes('multimedia.nt.qq.com.cn'),
        isHttp: url.startsWith('http://'),
        isHttps: url.startsWith('https://'),
        domain: url.startsWith('http') ? new URL(url).hostname : 'local'
      }))
    })
    
    return images
  }

  // 检测图片大小和格式
  async function checkImageSize(imageUrl: string): Promise<{ size: number, isValid: boolean, contentType?: string }> {
    try {
      // 发送HEAD请求获取图片信息
      const response = await ctx.http.head(imageUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })
      
      const contentLength = parseInt((response as any).headers?.['content-length'] || '0')
      const contentType = (response as any).headers?.['content-type'] || ''
      const sizeInMB = contentLength / (1024 * 1024)
      
      // 检查图片格式
      const isValidFormat = contentType.startsWith('image/jpeg') || 
                           contentType.startsWith('image/jpg') || 
                           contentType.startsWith('image/png')
      
      const isValidSize = sizeInMB <= config.maxImageSize && sizeInMB > 0.01 // 至少10KB
      const isValid = isValidFormat && isValidSize
      
      logInfo('手办化模块: 图片检测', {
        url: imageUrl.substring(0, 100) + '...',
        sizeInMB: sizeInMB.toFixed(2),
        contentType: contentType,
        maxSize: config.maxImageSize,
        isValidFormat: isValidFormat,
        isValidSize: isValidSize,
        isValid: isValid
      })
      
      return { size: sizeInMB, isValid, contentType }
    } catch (error) {
      logError('手办化模块: 图片检测失败', {
        url: imageUrl.substring(0, 100) + '...',
        error: error?.message
      })
      // 检测失败时允许继续处理
      return { size: 0, isValid: true }
    }
  }

  // 处理图片URL - 参考动漫识别插件的简化处理逻辑
  async function processImageUrl(imageUrl: string): Promise<string> {
    try {
      // 直接使用图片URL，QQ图片的src已经是公网可访问的直链
      if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        logInfo('手办化模块: 使用图片直链', { 
          url: imageUrl.substring(0, 100) + '...',
          isQQImage: imageUrl.includes('gchat.qpic.cn') || imageUrl.includes('multimedia.nt.qq.com.cn'),
          domain: new URL(imageUrl).hostname
        })
        return imageUrl
      }
      
      // 不支持base64格式
      if (imageUrl.startsWith('data:image/')) {
        logError('手办化模块: API不支持base64格式', { 
          imageType: imageUrl.substring(5, imageUrl.indexOf(';')),
          dataLength: imageUrl.length 
        })
        throw new Error('API不支持base64格式，请发送图片而不是粘贴图片')
      }
      
      logError('手办化模块: 不支持的图片格式', { imageUrl: imageUrl.substring(0, 100) })
      throw new Error('不支持的图片格式，请发送图片而不是链接')
      
    } catch (error) {
      logError('手办化模块: 图片处理失败', error)
      throw error
    }
  }

  // 等待图片 - 保留兼容性，但不再使用
  async function waitForImage(session: any, style: number): Promise<string> {
    const userId = session.userId
    
    // 清除之前的等待状态
    if (waitingImages.has(userId)) {
      const { timeout } = waitingImages.get(userId)!
      clearTimeout(timeout)
    }
    
    // 设置超时时间
    const timeoutMs = config.cooldownTime * 1000
    const timeout = setTimeout(() => {
      waitingImages.delete(userId)
      processingUsers.delete(userId)
      session.send('等待超时，请重新发送指令')
    }, timeoutMs)
    
    waitingImages.set(userId, { style, timeout })
    
    return `请发送一张图片，我将使用风格${style}进行手办化处理（${config.cooldownTime}秒内有效）`
  }

  // 处理图片
  async function processImage(session: any, imageUrl: string, style: number): Promise<void> {
    const userId = session.userId
    let processedUrl: string | undefined
    
    try {
      logInfo(`手办化模块: 开始处理图片，风格${style}`, { imageUrl: imageUrl.substring(0, 100) + '...', userId })
      
      // 发送处理中消息
      await session.send('正在生成手办化图片，请稍候...')
      
      // 处理图片URL
      processedUrl = await processImageUrl(imageUrl)
      logInfo('手办化模块: 图片URL处理完成', { 
        original: imageUrl.substring(0, 50) + '...',
        processed: processedUrl.substring(0, 50) + '...'
      })
      
      // 验证API密钥
      if (!config.apiKey || config.apiKey.trim() === '') {
        logError('手办化模块: API密钥为空，无法调用API')
        await session.send('手办化失败: API密钥未配置')
        processingUsers.delete(userId)
        return
      }

      // 使用默认超时时间
      const dynamicTimeout = config.apiTimeout
      
      // 调用API
      logInfo('手办化模块: 发送API请求', {
        style: style,
        url: processedUrl.substring(0, 100) + '...',
        keyLength: config.apiKey?.length || 0,
        keyValue: config.apiKey ? config.apiKey.substring(0, 4) + '...' : 'undefined',
        urlType: 'network_url',
        timeout: dynamicTimeout,
        originalTimeout: config.apiTimeout
      })
      
      // 根据API文档，只支持GET请求，所有参数都是query参数
      const response = await ctx.http.get('https://v2.xxapi.cn/api/generateFigurineImage', {
        params: {
          style: style,
          url: processedUrl,
          key: config.apiKey
        },
        timeout: dynamicTimeout * 1000 // 使用动态调整的超时时间
      }) as FigurineResponse
      
      logInfo('手办化模块: API响应', { 
        code: response.code, 
        msg: response.msg,
        hasData: !!response.data,
        requestId: response.request_id,
        fullResponse: response
      })
      
      if (response.code !== 200) {
        // 根据错误码提供更具体的错误信息
        let errorMessage = response.msg || '未知错误'
        switch (response.code) {
          case -2:
            errorMessage = '图片处理失败，请确保图片URL直接指向图片文件，避免使用动态生成的图片服务'
            break
          case -4:
            errorMessage = '图片不合法，请使用JPG或PNG格式的图片，大小建议1-5MB'
            break
          case -8:
            errorMessage = 'API密钥错误，请检查配置'
            break
          case -1:
            errorMessage = '参数错误，请检查图片链接'
            break
          default:
            errorMessage = response.msg || `错误码: ${response.code}`
        }
        
        logError('手办化模块: API返回错误', { 
          code: response.code, 
          msg: response.msg,
          errorMessage: errorMessage,
          requestId: response.request_id,
          fullResponse: response,
          requestType: 'GET',
          requestParams: {
            style: style,
            url: processedUrl.substring(0, 100) + '...',
            keyLength: config.apiKey?.length || 0
          }
        })
        await session.send(`手办化失败: ${errorMessage}`)
        // 处理失败时立即清除处理状态
        processingUsers.delete(userId)
        return
      }
      
      if (!response.data) {
        logError('手办化模块: API返回数据为空')
        await session.send('手办化失败: 未获取到生成图片')
        // 处理失败时立即清除处理状态
        processingUsers.delete(userId)
        return
      }
      
      // 发送生成的图片
      const imageMessage = h.image(response.data)
      await session.send(imageMessage)
      
      logInfo('手办化模块: 成功发送手办化图片', { 
        style, 
        originalUrl: imageUrl.substring(0, 50) + '...',
        resultUrl: response.data.substring(0, 50) + '...',
        requestId: response.request_id,
        resultDataLength: response.data?.length || 0
      })
      
      // 等待配置的时间后清除处理状态
      setTimeout(() => {
        processingUsers.delete(userId)
        logInfo('手办化模块: 用户处理状态已清除', { userId })
      }, config.cooldownTime * 1000)
      
    } catch (error) {
      let errorMessage = '手办化处理失败，请稍后重试'
      
      // 根据错误类型提供更具体的提示
      if (error?.message?.includes('request timeout') || error?.code === 'ETIMEDOUT') {
        errorMessage = '处理超时，图片可能过大或网络较慢，请尝试使用较小的图片'
      } else if (error?.message?.includes('图片过大')) {
        errorMessage = error.message
      } else if (error?.message?.includes('API不支持')) {
        errorMessage = error.message
      } else if (error?.message?.includes('不支持的图片格式')) {
        errorMessage = error.message
      }
      
      logError('手办化模块: 处理图片失败', {
        error: error,
        errorMessage: error?.message || '未知错误',
        errorStack: error?.stack,
        userId: userId,
        style: style,
        imageUrl: imageUrl.substring(0, 100) + '...',
        processedUrl: processedUrl?.substring(0, 100) + '...' || '未处理'
      })
      
      await session.send(errorMessage)
      // 处理失败时立即清除处理状态
      processingUsers.delete(userId)
    }
  }

  // 设置手办化指令 - 参考yunwu插件的实现
  ctx.command('手办化 [img:text]', '通过图片生成手办化效果')
    .option('style', '-s <style:number>', { fallback: 1 })
    .action(async ({ session, options }, img) => {
      const userId = session.userId
      const style = Number(options?.style) || 1
      
      // 检查用户是否正在处理中
      if (processingUsers.has(userId)) {
        return '手办化正在处理中，请等待当前任务完成后再试'
      }
      
      // 立即标记用户为处理中状态，防止重复调用
      processingUsers.add(userId)
      
      try {
        logInfo(`手办化模块: 用户请求手办化风格${style}`, { userId })
        
        // 使用新的getImageUrl函数获取图片
        const imageUrl = await getImageUrl(img, session)
        if (!imageUrl) {
          processingUsers.delete(userId)
          return  // 错误信息已在 getImageUrl 中发送
        }
        
        // 直接处理图片
        return await processImage(session, imageUrl, style)
      } catch (error) {
        logError('手办化模块错误', error)
        // 处理失败时也要清除处理状态
        processingUsers.delete(userId)
        return '手办化处理失败，请稍后重试'
      }
    })

  // 添加重置处理状态的指令
  ctx.command('手办化重置', '重置手办化处理状态')
    .action(async (argv) => {
      const userId = argv.session.userId
      const wasProcessing = processingUsers.has(userId)
      
      // 清除处理状态
      processingUsers.delete(userId)
      
      // 清除等待状态
      if (waitingImages.has(userId)) {
        const { timeout } = waitingImages.get(userId)!
        clearTimeout(timeout)
        waitingImages.delete(userId)
      }
      
      logInfo('手办化模块: 手动重置用户状态', { userId, wasProcessing })
      
      return wasProcessing ? '已重置处理状态，可以重新使用手办化指令' : '当前没有处理中的任务'
    })

  // 监听消息事件，处理等待中的图片 - 保留兼容性，但主要逻辑已移至getImageUrl
  ctx.on('message', async (session) => {
    if (session.userId && waitingImages.has(session.userId)) {
      const images = extractImages(session)
      if (images.length > 0) {
        const { style, timeout } = waitingImages.get(session.userId)!
        clearTimeout(timeout)
        waitingImages.delete(session.userId)
        
        try {
          await processImage(session, images[0], style)
        } catch (error) {
          logError('手办化模块: 处理等待的图片失败', error)
          await session.send('手办化处理失败，请稍后重试')
          // 处理失败时也要清除处理状态
          processingUsers.delete(session.userId)
        }
      }
    }
  })

  // 插件卸载时清理资源
  ctx.on('dispose', () => {
    // 清理所有等待中的超时器
    for (const [userId, { timeout }] of waitingImages) {
      clearTimeout(timeout)
    }
    waitingImages.clear()
    // 清理处理状态
    processingUsers.clear()
  })
}