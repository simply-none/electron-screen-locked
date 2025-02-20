import { createRouter, createWebHashHistory } from 'vue-router'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      redirect: '/home',
    },
    {
      path: '/test',
      name: 'test',
      component: () => import('../views/test.vue')
    },
    {
      path: '/home',
      name: 'home',
      component: () => import('../views/home/index.vue')
    },
    {
      path: '/setting',
      name: 'setting',
      component: () => import('../views/setting.vue')
    },
    {
      path: '/small',
      name: 'small',
      component: () => import('../views/smallWindow.vue')
    }
  ]
})