import { Context, Schema, h } from 'koishi'

export const name = 'aka-xxapi-figurine'

export interface Config {
  apiKey: string
  cooldownTime: number
  enableLog: boolean
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().required().description('API密钥'),
  cooldownTime: Schema.number().default(5000).min(1000).max(60000).description('等待发送图片的时间(毫秒)'),
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

  // 提取图片
  function extractImages(session: any): string[] {
    const images: string[] = []
    
    // 首先尝试从session.elements中提取图片
    if (session.elements) {
      for (const element of session.elements) {
        if (element.type === 'image' || element.type === 'img') {
          // 处理图片元素
          const url = element.attrs?.url || element.attrs?.src
          if (url) {
            images.push(url)
            logInfo('手办化模块: 从elements中提取到图片', { 
              type: element.type,
              url: url.substring(0, 100) + '...',
              attrs: element.attrs
            })
          }
        }
      }
    }
    
    // 如果elements中没有找到图片，尝试从content中提取
    if (images.length === 0 && session.content) {
      // 匹配图片URL模式
      const urlPattern = /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp)/gi
      const urlMatches = session.content.match(urlPattern)
      if (urlMatches) {
        images.push(...urlMatches)
        logInfo('手办化模块: 从content中提取到图片URL', { count: urlMatches.length })
      }
      
      // 匹配base64图片
      const base64Pattern = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi
      const base64Matches = session.content.match(base64Pattern)
      if (base64Matches) {
        images.push(...base64Matches)
        logInfo('手办化模块: 从content中提取到base64图片', { count: base64Matches.length })
      }
    }
    
    logInfo('手办化模块: 图片提取结果', { 
      totalImages: images.length,
      hasElements: !!session.elements,
      elementsCount: session.elements?.length || 0,
      contentLength: session.content?.length || 0
    })
    
    return images
  }

  // 上传图片到临时服务器
  async function uploadImageToTempServer(imageUrl: string): Promise<string> {
    try {
      // 如果是网络URL，直接返回
      if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        logInfo('手办化模块: 使用网络URL', { url: imageUrl.substring(0, 100) + '...' })
        return imageUrl
      }
      
      // 如果是base64，直接返回
      if (imageUrl.startsWith('data:image/')) {
        logInfo('手办化模块: 使用base64图片')
        return imageUrl
      }
      
      // 如果是本地文件路径，尝试上传到临时服务器
      if (imageUrl.startsWith('file://')) {
        logInfo('手办化模块: 检测到本地文件路径，尝试上传', { originalUrl: imageUrl })
        
        // 将file://路径转换为实际文件路径
        const filePath = imageUrl.replace('file://', '')
        
        // 读取文件并转换为base64
        const fs = await import('fs/promises')
        const fileBuffer = await fs.readFile(filePath)
        const base64 = fileBuffer.toString('base64')
        
        // 根据文件扩展名确定MIME类型
        const ext = filePath.split('.').pop()?.toLowerCase()
        let mimeType = 'image/jpeg'
        if (ext === 'png') mimeType = 'image/png'
        else if (ext === 'gif') mimeType = 'image/gif'
        else if (ext === 'webp') mimeType = 'image/webp'
        
        const dataUrl = `data:${mimeType};base64,${base64}`
        logInfo('手办化模块: 本地文件转换为base64成功', { 
          filePath: filePath.substring(0, 50) + '...',
          size: fileBuffer.length,
          mimeType
        })
        
        return dataUrl
      }
      
      logError('手办化模块: 不支持的图片格式', { imageUrl: imageUrl.substring(0, 100) })
      throw new Error('不支持的图片格式')
      
    } catch (error) {
      logError('手办化模块: 图片上传处理失败', error)
      throw error
    }
  }

  // 等待图片
  async function waitForImage(session: any, style: number): Promise<string> {
    const userId = session.userId
    
    // 标记用户为处理中状态
    processingUsers.add(userId)
    
    // 清除之前的等待状态
    if (waitingImages.has(userId)) {
      const { timeout } = waitingImages.get(userId)!
      clearTimeout(timeout)
    }
    
    // 设置10秒超时
    const timeout = setTimeout(() => {
      waitingImages.delete(userId)
      processingUsers.delete(userId)
      session.send('等待超时，请重新发送指令')
    }, 10000)
    
    waitingImages.set(userId, { style, timeout })
    
    return `请发送一张图片，我将使用风格${style}进行手办化处理（10秒内有效）`
  }

  // 处理图片
  async function processImage(session: any, imageUrl: string, style: number): Promise<void> {
    const userId = session.userId
    
    try {
      // 标记用户为处理中状态
      processingUsers.add(userId)
      
      logInfo(`手办化模块: 开始处理图片，风格${style}`, { imageUrl: imageUrl.substring(0, 100) + '...' })
      
      // 发送处理中消息
      await session.send('正在生成手办化图片，请稍候...')
      
      // 处理图片URL
      const processedUrl = await uploadImageToTempServer(imageUrl)
      logInfo('手办化模块: 图片URL处理完成', { 
        original: imageUrl.substring(0, 50) + '...',
        processed: processedUrl.substring(0, 50) + '...'
      })
      
      // 调用API
      const response = await ctx.http.get('https://v2.xxapi.cn/api/generateFigurineImage', {
        params: {
          style: style,
          url: processedUrl,
          key: config.apiKey
        },
        timeout: 30000
      }) as FigurineResponse
      
      logInfo('手办化模块: API响应', { code: response.code })
      
      if (response.code !== 200) {
        logError('手办化模块: API返回错误', { code: response.code, msg: response.msg })
        await session.send(`手办化失败: ${response.msg || '未知错误'}`)
        return
      }
      
      if (!response.data) {
        logError('手办化模块: API返回数据为空')
        await session.send('手办化失败: 未获取到生成图片')
        return
      }
      
      // 发送生成的图片
      const imageMessage = h.image(response.data)
      await session.send(imageMessage)
      
      logInfo('手办化模块: 成功发送手办化图片', { 
        style, 
        originalUrl: imageUrl.substring(0, 50) + '...',
        resultUrl: response.data.substring(0, 50) + '...'
      })
      
      // 等待配置的时间后清除处理状态
      setTimeout(() => {
        processingUsers.delete(userId)
        logInfo('手办化模块: 用户处理状态已清除', { userId })
      }, config.cooldownTime)
      
    } catch (error) {
      logError('手办化模块: 处理图片失败', error)
      await session.send('手办化处理失败，请检查图片链接是否有效或稍后重试')
      // 处理失败时立即清除处理状态
      processingUsers.delete(userId)
    }
  }

  // 设置手办化指令
  for (let style = 1; style <= 4; style++) {
    ctx.command(`手办化${style}`, `使用风格${style}进行手办化`)
      .action(async (argv) => {
        try {
          const userId = argv.session.userId
          
          // 检查用户是否正在处理中
          if (processingUsers.has(userId)) {
            return '手办化正在处理中，请等待当前任务完成后再试'
          }
          
          logInfo(`手办化模块: 用户请求手办化风格${style}`)
          
          // 检查消息中是否有图片
          const images = extractImages(argv.session)
          if (images.length > 0) {
            // 直接处理第一张图片
            return await processImage(argv.session, images[0], style)
          } else {
            // 没有图片，等待用户发送图片
            return await waitForImage(argv.session, style)
          }
        } catch (error) {
          logError('手办化模块错误', error)
          return '手办化处理失败，请稍后重试'
        }
      })
  }

  // 监听消息事件，处理等待中的图片
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