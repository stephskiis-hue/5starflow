Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\Users\steph\Desktop\5starflow\.claude\screenshots\index-t2-desktop-full2.png'
$src = [System.Drawing.Bitmap]::new($srcPath)

$crops = @(
  @{name="s1-hero-trust-problem"; y=0; h=1800},
  @{name="s2-how-it-works-features"; y=1800; h=1800},
  @{name="s3-how-powered-testimonials"; y=3400; h=1400},
  @{name="s4-pricing-roi"; y=4600; h=1400}
)

foreach ($c in $crops) {
  $h = [Math]::Min($c.h, $src.Height - $c.y)
  if ($h -le 0) { continue }
  $rect = [System.Drawing.Rectangle]::new(0, $c.y, $src.Width, $h)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $outPath = "C:\Users\steph\Desktop\5starflow\.claude\screenshots\crop-desktop-$($c.name).png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Saved: $outPath"
}
$src.Dispose()
Write-Host "Done"
