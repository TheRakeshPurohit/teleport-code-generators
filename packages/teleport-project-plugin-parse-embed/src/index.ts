import { UIDLUtils } from '@teleporthq/teleport-shared'
import {
  ProjectPluginStructure,
  ProjectPlugin,
  UIDLElementNode,
  UIDLRootComponent,
  ComponentUIDL,
} from '@teleporthq/teleport-types'
import { SUPPORTED_PROJECT_TYPES, JS_EXECUTION_DEPENDENCIES } from './utils'

const NODE_MAPPER: Record<SUPPORTED_PROJECT_TYPES, Promise<(content: unknown) => string>> = {
  'teleport-project-html': import('hast-util-to-html').then((mod) => mod.toHtml),
  'teleport-project-react': import('hast-util-to-jsx-inline-script').then((mod) => mod.default),
  'teleport-project-next': import('hast-util-to-jsx-inline-script').then((mod) => mod.default),
}

export class ProjectPluginParseEmbed implements ProjectPlugin {
  fromHtml: (value: string, opts: { fragment: boolean }) => unknown
  hastToJsxOrHtml: (content: unknown) => string

  async loadFromHTML(): Promise<(value: string, opts: { fragment: boolean }) => unknown> {
    if (!this.fromHtml) {
      this.fromHtml = (await import('hast-util-from-html')).fromHtml
    }
    return this.fromHtml
  }

  async loadNodeMapper(id: SUPPORTED_PROJECT_TYPES): Promise<(content: unknown) => string> {
    if (!this.hastToJsxOrHtml) {
      this.hastToJsxOrHtml = await NODE_MAPPER[id]
    }
    return this.hastToJsxOrHtml
  }

  async traverseComponentUIDL(
    node: UIDLElementNode,
    id: SUPPORTED_PROJECT_TYPES
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      try {
        let shouldAddJSDependency = false
        UIDLUtils.traverseElements(node, (element) => {
          if (element.elementType === 'html-node' && element.attrs?.html && NODE_MAPPER[id]) {
            const hastNodes = this.fromHtml(element.attrs.html.content as string, {
              fragment: true,
            })
            const content = this.hastToJsxOrHtml(hastNodes)
            element.elementType = 'container'
            element.attrs = {}
            element.style = { display: { type: 'static', content: 'contents' } }
            element.children = [
              {
                type: 'inject',
                content,
              },
            ]

            if (content.includes('<Script')) {
              shouldAddJSDependency = true
            }
          }
        })

        resolve(shouldAddJSDependency)
      } catch (error) {
        reject(error)
      }
    })
  }

  async traverseNodeAndAddImport(
    componentUIDL: UIDLRootComponent | ComponentUIDL,
    projectType: SUPPORTED_PROJECT_TYPES
  ) {
    const shouldAddJSDependency = await this.traverseComponentUIDL(componentUIDL.node, projectType)

    if (shouldAddJSDependency) {
      componentUIDL.importDefinitions = {
        ...(componentUIDL?.importDefinitions || {}),
        ...JS_EXECUTION_DEPENDENCIES[projectType],
      }
    }
  }

  async runBefore(structure: ProjectPluginStructure) {
    await this.loadFromHTML()
    const projectType = structure.strategy.id as SUPPORTED_PROJECT_TYPES
    await this.loadNodeMapper(projectType)

    if (!NODE_MAPPER[projectType]) {
      return structure
    }

    const promises: Array<Promise<void>> = []
    promises.push(this.traverseNodeAndAddImport(structure.uidl.root, projectType))
    const components = Object.keys(structure.uidl?.components || {})
    for (let i = 0; i < components.length; i++) {
      promises.push(
        this.traverseNodeAndAddImport(structure.uidl.components[components[i]], projectType)
      )
    }

    await Promise.all(promises)
    return structure
  }

  async runAfter(structure: ProjectPluginStructure) {
    if (!NODE_MAPPER[structure.strategy.id as SUPPORTED_PROJECT_TYPES]) {
      return structure
    }

    if (structure.strategy.id === 'teleport-project-react') {
      structure.dependencies['dangerous-html'] = '^0.1.13'
    }

    return structure
  }
}