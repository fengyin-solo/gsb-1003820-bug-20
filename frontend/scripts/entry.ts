// 验证脚本的打包入口：暴露服务层与故障注入。
export {
  listEntries,
  runAction,
  loadOverview,
  exportEntries,
  sealCurrentShift,
  listSealedShifts,
} from '@/api/local-service'
export { __setFailCollectAt } from '@/data/local-store'
