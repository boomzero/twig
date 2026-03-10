import './assets/main.css'
import { mount } from 'svelte'
import Presentation from './Presentation.svelte'

const app = mount(Presentation, {
  target: document.getElementById('app')!
})

export default app
