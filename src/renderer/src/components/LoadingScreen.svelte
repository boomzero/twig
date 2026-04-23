<script lang="ts">
  import { _ } from 'svelte-i18n'
  import twigLogo from '../../../../resources/icon.png?asset'

  export type LoadingPhase = 'booting' | 'opening' | 'creating' | 'switching'

  const { phase = 'booting', compact = false }: { phase?: LoadingPhase; compact?: boolean } =
    $props()
</script>

<div
  class={`flex flex-col items-center justify-center text-center ${
    compact ? 'gap-3 px-5 py-5' : 'min-h-screen gap-4 px-6 py-8'
  }`}
  role="status"
  aria-live="polite"
  aria-atomic="true"
>
  <div
    class={`twig-loader-mark flex items-center justify-center overflow-hidden border border-white/70 bg-[#20242d] shadow-[0_18px_48px_-26px_rgba(15,23,42,0.8)] ${
      compact ? 'h-16 w-16 rounded-[22px]' : 'h-[88px] w-[88px] rounded-[28px]'
    }`}
  >
    <img src={twigLogo} alt="twig logo" class="h-full w-full object-contain" draggable="false" />
  </div>

  <div class="space-y-1">
    <div
      class={`font-medium uppercase tracking-[0.28em] text-gray-500 ${
        compact ? 'text-[10px]' : 'text-[11px]'
      }`}
    >
      twig
    </div>
    {#if !compact}
      <h1 class="font-semibold text-gray-900 text-2xl">
        {$_('loading.title')}
      </h1>
    {/if}
    <p class={`text-gray-500 ${compact ? 'text-xs' : 'text-sm'}`}>
      {#if phase === 'opening'}
        {$_('loading.opening')}
      {:else if phase === 'creating'}
        {$_('loading.creating')}
      {:else if phase === 'switching'}
        {$_('loading.switching')}
      {:else}
        {$_('loading.booting')}
      {/if}
    </p>
  </div>
</div>

<style>
  .twig-loader-mark {
    animation: twig-loader-breathe 1.8s ease-in-out infinite;
    will-change: transform;
  }

  @keyframes twig-loader-breathe {
    0%,
    100% {
      transform: translateY(0);
      box-shadow: 0 18px 48px -26px rgba(15, 23, 42, 0.8);
    }

    50% {
      transform: translateY(-3px);
      box-shadow: 0 24px 58px -28px rgba(45, 212, 191, 0.55);
    }
  }
</style>
